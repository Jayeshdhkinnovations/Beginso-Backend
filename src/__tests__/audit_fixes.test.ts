// Backend audit fixes: personal-form ownership in ONE place (requirePermission), personal bulk
// actions, /auth/me suspension, sessionless-token rejection, and the member default preference.
process.env.JWT_SECRET = "test-jwt-secret-audit-fixes";
process.env.RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import ResponseReadState from "../models/ResponseReadState";
import Invitation from "../models/Invitation";
import SessionModel from "../models/Session";
import FormAccessGrant from "../models/FormAccessGrant";
import { generateToken } from "../utils/generateToken";

let mongo: MongoMemoryServer;
let owner: any, other: any, grantee: any, wsOwner: any, suspended: any, invitee: any;
let tOwner: string, tOther: string, tGrantee: string, tSuspended: string, tInvitee: string;
let personalForm: any, otherForm: any, wsForm: any, r1: any, r2: any, rWs: any;

const tok = (u: any, sessionId?: string) => generateToken({ id: u._id.toString(), email: u.email, role: "user", sessionId });
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const fld: any[] = [{ fieldId: "f1", label: "Name", type: "short_text", required: false }];

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const mk = (n: string, extra: any = {}) =>
    User.create({ firebaseUid: `uid-audit-${n}`, fullName: n, email: `${n}@audit.test`, status: "active", ...extra });
  [owner, other, grantee, wsOwner, suspended, invitee] = await Promise.all([
    mk("owner"), mk("other"), mk("grantee"), mk("wsowner"), mk("susp", { status: "suspended" }), mk("invitee"),
  ]);
  tOwner = tok(owner);
  tOther = tok(other);
  tGrantee = tok(grantee);
  tSuspended = tok(suspended);
  tInvitee = tok(invitee);

  const ws = await Workspace.create({ name: "Audit WS", slug: "audit-ws", owner: wsOwner._id });
  await Membership.create({ userId: wsOwner._id, workspaceId: ws._id, role: "owner" });
  // `other` is a plain workspace member too, so no-header requests have a default workspace to fall back to.
  await Membership.create({ userId: other._id, workspaceId: ws._id, role: "member" });

  personalForm = await Form.create({ title: "Mine", createdBy: owner._id, workspaceId: null, status: "published", fields: fld });
  otherForm = await Form.create({ title: "Theirs", createdBy: other._id, workspaceId: null, status: "published", fields: fld });
  wsForm = await Form.create({ title: "WS", createdBy: wsOwner._id, workspaceId: ws._id, status: "published", fields: fld });
  r1 = await ResponseModel.create({ formId: personalForm._id, answers: {}, submittedAt: new Date() });
  r2 = await ResponseModel.create({ formId: otherForm._id, answers: {}, submittedAt: new Date() });
  rWs = await ResponseModel.create({ formId: wsForm._id, answers: {}, submittedAt: new Date() });
  await FormAccessGrant.create({ formId: personalForm._id, userId: grantee._id, role: "viewer", grantedBy: owner._id } as any);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("personal-form ownership is enforced in requirePermission (every form/response route)", () => {
  it("owner can read, unread and see activity on their personal response", async () => {
    expect((await request(app).post(`/api/responses/${r1._id}/read`).set(auth(tOwner))).status).toBe(200);
    expect((await request(app).post(`/api/responses/${r1._id}/unread`).set(auth(tOwner))).status).toBe(200);
    const act = await request(app).get(`/api/responses/${r1._id}/activity`).set(auth(tOwner));
    expect(act.status).toBe(200);
    expect(act.body.activity.map((a: any) => a.type)).toEqual(["submitted"]);
  });

  it("another user (even a workspace member) gets 403 and no read-state row is written", async () => {
    const calls: Array<["get" | "post", string]> = [
      ["post", `/api/responses/${r1._id}/read`],
      ["post", `/api/responses/${r1._id}/unread`],
      ["get", `/api/responses/${r1._id}/activity`],
      ["get", `/api/responses/${r1._id}`],
      ["get", `/api/responses/${r1._id}/notes`],
      ["get", `/api/responses/${r1._id}/score`],
      ["get", `/api/forms/${personalForm._id}`],
      ["get", `/api/forms/${personalForm._id}/score-comparison`],
    ];
    for (const [method, url] of calls) {
      const res = await request(app)[method](url).set(auth(tOther));
      expect([method, url, res.status]).toEqual([method, url, 403]);
    }
    expect(await ResponseReadState.countDocuments({ userId: other._id, responseId: r1._id })).toBe(0);
  });

  it("a per-form grant still opens a personal form (viewer grant: read yes, write no)", async () => {
    expect((await request(app).post(`/api/responses/${r1._id}/read`).set(auth(tGrantee))).status).toBe(200);
    expect((await request(app).patch(`/api/responses/${r1._id}`).set(auth(tGrantee)).send({ status: "completed" })).status).toBe(403);
  });
});

describe("bulk actions on personal forms", () => {
  it("the personal owner can bulk act on their own responses but not on another user's personal ones", async () => {
    const res = await request(app)
      .post("/api/responses/bulk")
      .set({ ...auth(tOwner), "x-workspace-slug": "personal" })
      .send({ target: { ids: [r1._id.toString(), r2._id.toString()] }, action: { type: "read" } });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toEqual([r1._id.toString()]);
    expect(res.body.failed.map((f: any) => f.id)).toEqual([r2._id.toString()]);
  });

  it("filter target in personal context resolves only the caller's personal forms", async () => {
    const res = await request(app)
      .post("/api/responses/bulk")
      .set({ ...auth(tOwner), "x-workspace-slug": "personal" })
      .send({ target: { filter: {} }, action: { type: "unread" } });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toEqual([r1._id.toString()]);
  });

  it("a workspace member cannot bulk act on another user's personal response", async () => {
    const res = await request(app)
      .post("/api/responses/bulk")
      .set(auth(tOther))
      .send({ target: { ids: [r1._id.toString(), rWs._id.toString()] }, action: { type: "read" } });
    expect(res.status).toBe(200);
    expect(res.body.failed.map((f: any) => f.id)).toContain(r1._id.toString());
    expect(res.body.succeeded).not.toContain(r1._id.toString());
  });
});

describe("/auth/me rejects suspended users", () => {
  it("403 ACCOUNT_SUSPENDED for suspended, 200 for active", async () => {
    const bad = await request(app).get("/api/auth/me").set(auth(tSuspended));
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe("ACCOUNT_SUSPENDED");
    expect((await request(app).get("/api/auth/me").set(auth(tOwner))).status).toBe(200);
  });
});

describe("protect rejects tokens without a sessionId (not revocable)", () => {
  afterEach(() => {
    process.env.ALLOW_SESSIONLESS_TOKENS = "true"; // suite default, see setup.ts
  });

  it("sessionless token -> 401 in production mode; session token works until revoked", async () => {
    process.env.ALLOW_SESSIONLESS_TOKENS = "false";
    expect((await request(app).get("/api/auth/me").set(auth(tOwner))).status).toBe(401);

    const session = await SessionModel.create({ userId: owner._id, deviceLabel: "test", ipHash: "h", lastActiveAt: new Date() } as any);
    const withSession = tok(owner, session._id.toString());
    expect((await request(app).get("/api/auth/me").set(auth(withSession))).status).toBe(200);

    await SessionModel.updateOne({ _id: session._id }, { $set: { revokedAt: new Date() } });
    expect((await request(app).get("/api/auth/me").set(auth(withSession))).status).toBe(401);
  });
});

describe("invite-accept default notification preference", () => {
  it("a newly accepted member defaults to 'none' (spec P1)", async () => {
    const ws = await Workspace.findOne({ slug: "audit-ws" });
    await Invitation.create({
      workspaceId: ws!._id,
      email: invitee.email,
      role: "member",
      status: "pending",
      token: "audit-invite-token",
      expiresAt: new Date(Date.now() + 86_400_000),
    } as any);
    const res = await request(app).post("/api/invitations/audit-invite-token/accept").set(auth(tInvitee));
    expect(res.status).toBe(200);
    const m = await Membership.findOne({ userId: invitee._id, workspaceId: ws!._id });
    expect(m!.notificationPreference).toBe("none");
  });
});
