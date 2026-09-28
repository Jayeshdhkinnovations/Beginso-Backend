// Security regression suite (audit BACKEND-AUDIT-2026-09, blocker B1).
//
// Every test states the CORRECT behaviour. Tests written with `openHole` are holes that
// are still open: `it.failing` keeps CI green while the bug exists, and turns RED the day
// the bug is fixed, which is the signal to change `openHole(` to `it(` for that test.
// Do not delete an `openHole` test to make CI pass.
// To see the open holes as real red failures while fixing them:
//   SEC_SHOW_OPEN=1 npx jest src/__tests__/security_regression.test.ts
jest.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    createUser: async (data: any) => ({ uid: `mock-uid-${data.email}` }),
    verifyIdToken: async (token: string) => ({ uid: `mock-uid-${token}`, email: `${token}@test.com`, name: token }),
    deleteUser: async () => ({}),
    updateUser: async () => ({}),
    getUserByEmail: async () => ({ uid: "x" }),
  }),
}));

jest.mock("firebase-admin/app", () => ({
  initializeApp: () => {},
  cert: () => {},
  getApps: () => [],
}));

// Plain function (not jest.fn) so `resetMocks: true` cannot strip the implementation.
jest.mock("../services/mail.service", () => ({
  mailService: { sendMail: async () => ({ messageId: "test" }) },
}));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Invitation from "../models/Invitation";
import FormAccessGrant from "../models/FormAccessGrant";
import SessionModel from "../models/Session";
import Upload from "../models/Upload";
import { generateToken } from "../utils/generateToken";

const openHole = process.env.SEC_SHOW_OPEN ? it : it.failing;

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "beginso-sec-"));
process.env.UPLOAD_DIR = uploadDir;
process.env.JWT_SECRET = "test-jwt-secret-key-for-security-regression-suite";

let mongoServer: MongoMemoryServer;
let wsA: any;
let wsB: any;
let ownerA: any; // owner of A, default workspace A, NO membership in B
let ownerB: any;
let editorB: any;
let reviewerB: any;
let dual: any; // owner of A, reviewer in B, sticky default workspace = B
let outsider: any; // no membership anywhere

const tok = (u: any, sessionId?: string) =>
  generateToken({ id: u._id.toString(), email: u.email, role: u.role, ...(sessionId ? { sessionId } : {}) });

const mkUser = (key: string, workspaceId: any = null) =>
  User.create({ firebaseUid: `uid-${key}`, fullName: key, email: `${key}@sec.test`, role: "admin", status: "active", workspaceId });

const mkForm = (workspaceId: any, createdBy: any, extra: any = {}) =>
  Form.create({
    title: `form-${crypto.randomBytes(3).toString("hex")}`,
    workspaceId,
    createdBy,
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
    ...extra,
  });

const mkInvite = (
  workspaceId: any,
  email: string,
  status: "pending" | "accepted" | "declined" | "revoked" | "expired" = "pending",
  invitedBy: any = ownerB._id
) =>
  Invitation.create({
    workspaceId,
    email,
    role: "admin",
    status,
    token: crypto.randomBytes(16).toString("hex"),
    expiresAt: new Date(Date.now() + 86400000),
    invitedBy,
  });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Workspace, Membership, Form, ResponseModel, Invitation, FormAccessGrant, SessionModel, Upload].map((m: any) => m.init()));

  ownerA = await mkUser("ownerA");
  ownerB = await mkUser("ownerB");
  editorB = await mkUser("editorB");
  reviewerB = await mkUser("reviewerB");
  dual = await mkUser("dual");
  outsider = await mkUser("outsider");

  wsA = await Workspace.create({ name: "WS A", slug: "sec-ws-a", timezone: "UTC", owner: ownerA._id });
  wsB = await Workspace.create({ name: "WS B", slug: "sec-ws-b", timezone: "UTC", owner: ownerB._id });

  ownerA.workspaceId = wsA._id;
  await ownerA.save();
  ownerB.workspaceId = wsB._id;
  await ownerB.save();
  editorB.workspaceId = wsB._id;
  await editorB.save();
  reviewerB.workspaceId = wsB._id;
  await reviewerB.save();
  dual.workspaceId = wsB._id;
  await dual.save();

  await resetMemberships();
});

// Open holes really do mutate data (that is the bug), so every test starts from the canonical roles.
const resetMemberships = async () => {
  await Membership.deleteMany({});
  await Membership.create([
    { userId: ownerA._id, workspaceId: wsA._id, role: "owner" },
    { userId: ownerB._id, workspaceId: wsB._id, role: "owner" },
    { userId: editorB._id, workspaceId: wsB._id, role: "editor" },
    { userId: reviewerB._id, workspaceId: wsB._id, role: "reviewer" },
    { userId: dual._id, workspaceId: wsA._id, role: "owner" },
    { userId: dual._id, workspaceId: wsB._id, role: "reviewer" },
  ]);
};

beforeEach(resetMemberships);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

const auth = (r: request.Test, u: any) => r.set("Authorization", `Bearer ${tok(u)}`);

describe("Sanity: the fixtures behave as a legitimate tenant would expect", () => {
  it("owner of B can list B members", async () => {
    const res = await auth(request(app).get(`/api/workspaces/${wsB._id}/members`), ownerB);
    expect(res.status).toBe(200);
  });

  it("a non-member cannot list B members (no bypass signal)", async () => {
    const res = await auth(request(app).get(`/api/workspaces/${wsB._id}/members`), outsider);
    expect(res.status).toBe(403);
  });

  it("a reviewer cannot delete a form when they do not use a bypass signal", async () => {
    const form = await mkForm(wsB._id, ownerB._id);
    const res = await auth(request(app).delete(`/api/forms/${form._id}`), reviewerB);
    expect(res.status).toBe(403);
    expect(await Form.findById(form._id)).not.toBeNull();
  });

  it("a member id (userId) from workspace B is not addressable through workspace A's URL", async () => {
    const res = await auth(
      request(app).patch(`/api/workspaces/${wsA._id}/members/${editorB._id}`).send({ role: "viewer" }),
      ownerA
    );
    expect([403, 404]).toContain(res.status);
    const m = await Membership.findOne({ userId: editorB._id, workspaceId: wsB._id });
    expect(m?.role).toBe("editor");
  });
});

describe("S-01 personal-signal bypass of requirePermission", () => {
  openHole("non-member must not list B members with x-workspace-id: personal", async () => {
    const res = await auth(request(app).get(`/api/workspaces/${wsB._id}/members`).set("x-workspace-id", "personal"), outsider);
    expect(res.status).toBe(403);
  });

  openHole("non-member must not read B audit log with ?workspaceId=personal", async () => {
    const res = await auth(request(app).get(`/api/workspaces/${wsB._id}/audit?workspaceId=personal`), outsider);
    expect(res.status).toBe(403);
  });

  openHole("non-member must not invite themselves as admin into B", async () => {
    const res = await auth(
      request(app)
        .post(`/api/workspaces/${wsB._id}/invitations`)
        .set("x-workspace-id", "personal")
        .send({ email: outsider.email, role: "admin" }),
      outsider
    );
    expect(res.status).toBe(403);
    expect(await Invitation.countDocuments({ workspaceId: wsB._id, email: outsider.email })).toBe(0);
  });

  openHole("reviewer must not delete a form by sending ?workspaceId=personal", async () => {
    const form = await mkForm(wsB._id, ownerB._id);
    const res = await auth(request(app).delete(`/api/forms/${form._id}?workspaceId=personal`), reviewerB);
    expect(res.status).toBe(403);
    expect(await Form.findById(form._id)).not.toBeNull();
  });

  openHole("reviewer must not promote themselves to admin with a personal signal", async () => {
    const res = await auth(
      request(app)
        .patch(`/api/workspaces/${wsB._id}/members/${reviewerB._id}`)
        .set("x-workspace-id", "personal")
        .send({ role: "admin" }),
      reviewerB
    );
    expect(res.status).toBe(403);
    const m = await Membership.findOne({ userId: reviewerB._id, workspaceId: wsB._id });
    expect(m?.role).toBe("reviewer");
  });
});

describe("S-02 the workspace header must not override the workspace in the URL", () => {
  openHole("owner of A must not change a B member's role by sending x-workspace-id: A", async () => {
    const res = await auth(
      request(app).patch(`/api/workspaces/${wsB._id}/members/${editorB._id}`).set("x-workspace-id", wsA._id.toString()).send({ role: "viewer" }),
      ownerA
    );
    expect(res.status).toBe(403);
    const m = await Membership.findOne({ userId: editorB._id, workspaceId: wsB._id });
    expect(m?.role).toBe("editor");
  });

  openHole("owner of A must not read B's audit log by sending x-workspace-id: A", async () => {
    const res = await auth(request(app).get(`/api/workspaces/${wsB._id}/audit`).set("x-workspace-id", wsA._id.toString()), ownerA);
    expect(res.status).toBe(403);
  });

  openHole("owner of A must not revoke B's invitation by sending x-workspace-id: A", async () => {
    const inv = await mkInvite(wsB._id, "target@sec.test");
    const res = await auth(request(app).delete(`/api/invitations/${inv.token}`).set("x-workspace-id", wsA._id.toString()), ownerA);
    expect([403, 404]).toContain(res.status);
    expect((await Invitation.findById(inv._id))?.status).toBe("pending");
  });

  openHole("owner of A must not resend B's invitation by sending x-workspace-id: A", async () => {
    const inv = await mkInvite(wsB._id, "resend-target@sec.test");
    const res = await auth(request(app).post(`/api/invitations/${inv._id}/resend`).set("x-workspace-id", wsA._id.toString()), ownerA);
    expect([403, 404]).toContain(res.status);
  });
});

describe("S-13 role checked in one workspace, data changed in another", () => {
  openHole("a reviewer in B who owns A must not delete a B response via x-workspace-id: A", async () => {
    const form = await mkForm(wsB._id, ownerB._id);
    const resp = await ResponseModel.create({ formId: form._id, answers: {} });
    const res = await auth(request(app).delete(`/api/responses/${resp._id}`).set("x-workspace-id", wsA._id.toString()), dual);
    expect(res.status).toBe(403);
    expect(await ResponseModel.findById(resp._id)).not.toBeNull();
  });
});

describe("S-11 form write path", () => {
  openHole("an editor must not publish through PATCH status (forms:publish is required)", async () => {
    const form = await mkForm(wsB._id, ownerB._id);
    const res = await auth(request(app).patch(`/api/forms/${form._id}`).send({ status: "published" }), editorB);
    expect(res.status).toBe(403);
    expect((await Form.findById(form._id))?.status).toBe("draft");
  });

  openHole("an editor must not set publishedSlug through PUT", async () => {
    const form = await mkForm(wsB._id, ownerB._id);
    await auth(request(app).put(`/api/forms/${form._id}`).send({ title: "t", publishedSlug: "hijacked-slug" }), editorB);
    expect((await Form.findById(form._id))?.publishedSlug).not.toBe("hijacked-slug");
  });

  openHole("PUT must not be able to move a form out of its workspace with workspaceId: null", async () => {
    const form = await mkForm(wsB._id, ownerB._id);
    await auth(request(app).put(`/api/forms/${form._id}`).send({ title: "t", workspaceId: null }), editorB);
    expect((await Form.findById(form._id))?.workspaceId?.toString()).toBe(wsB._id.toString());
  });

  openHole("PUT must not honour Mongo operators in the body", async () => {
    const form = await mkForm(wsB._id, ownerB._id);
    await auth(request(app).put(`/api/forms/${form._id}`).send({ title: "t", $set: { workspaceId: wsA._id.toString() } }), editorB);
    expect((await Form.findById(form._id))?.workspaceId?.toString()).toBe(wsB._id.toString());
  });
});

describe("S-06 form access grants", () => {
  openHole("a non-member must not grant themselves admin on a B form", async () => {
    const form = await mkForm(wsB._id, ownerB._id);
    const res = await auth(
      request(app).post(`/api/forms/${form._id}/grants?workspaceId=personal`).send({ userId: outsider._id.toString(), role: "admin" }),
      outsider
    );
    expect(res.status).toBe(403);
    expect(await FormAccessGrant.countDocuments({ formId: form._id, userId: outsider._id })).toBe(0);
  });

  openHole("owner of A must not grant access on a B form via x-workspace-id: A", async () => {
    const form = await mkForm(wsB._id, ownerB._id);
    const res = await auth(
      request(app).post(`/api/forms/${form._id}/grants`).set("x-workspace-id", wsA._id.toString()).send({ userId: outsider._id.toString(), role: "admin" }),
      ownerA
    );
    expect(res.status).toBe(403);
    expect(await FormAccessGrant.countDocuments({ formId: form._id })).toBe(0);
  });
});

describe("S-18 form events and anonymous-ish submissions", () => {
  openHole("a non-member must not read a B form's events with ?workspaceId=personal", async () => {
    const form = await mkForm(wsB._id, ownerB._id);
    const res = await auth(request(app).get(`/api/forms/${form._id}/events?workspaceId=personal`), outsider);
    expect(res.status).toBe(403);
  });

  openHole("a non-member must not inject a response into a draft B form", async () => {
    const form = await mkForm(wsB._id, ownerB._id);
    const res = await auth(request(app).post(`/api/forms/${form._id}/submissions?workspaceId=personal`).send({ answers: { a: 1 } }), outsider);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await ResponseModel.countDocuments({ formId: form._id })).toBe(0);
  });
});

describe("S-12 invitation state", () => {
  openHole("a declined invitation must not be acceptable", async () => {
    const inv = await mkInvite(wsB._id, outsider.email, "declined");
    const res = await auth(request(app).post(`/api/invitations/${inv.token}/accept`), outsider);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await Membership.countDocuments({ userId: outsider._id, workspaceId: wsB._id })).toBe(0);
  });

  openHole("an already-used invitation must not re-add a removed member", async () => {
    const inv = await mkInvite(wsB._id, outsider.email, "accepted");
    const res = await auth(request(app).post(`/api/invitations/${inv.token}/accept`), outsider);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await Membership.countDocuments({ userId: outsider._id, workspaceId: wsB._id })).toBe(0);
  });

  openHole("an unauthenticated caller must not decline an accepted invitation", async () => {
    const inv = await mkInvite(wsB._id, "someone@sec.test", "accepted");
    await request(app).post(`/api/invitations/${inv.token}/decline`);
    expect((await Invitation.findById(inv._id))?.status).toBe("accepted");
  });
});

describe("S-15 logout", () => {
  openHole("a token must stop working after logout", async () => {
    const session = await SessionModel.create({
      userId: outsider._id,
      deviceLabel: "jest",
      userAgent: "jest",
      ipHash: "abcdabcdabcdabcd",
      lastActiveAt: new Date(),
    });
    const token = tok(outsider, session._id.toString());
    const before = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);

    await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);

    const after = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
  });
});

describe("S-04 attachment download must authorise the file it serves", () => {
  openHole("a user must not read another tenant's attachment by naming their own form in the URL", async () => {
    const victimForm = await mkForm(wsB._id, ownerB._id);
    const victimResp = await ResponseModel.create({ formId: victimForm._id, answers: {} });
    const rel = path.join(ownerB._id.toString(), victimForm._id.toString(), "responses", victimResp._id.toString(), "secret-report.pdf");
    fs.mkdirSync(path.dirname(path.join(uploadDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(uploadDir, rel), "TOP-SECRET-VICTIM-CONTENT");
    await Upload.create({ name: "secret-report.pdf", size: 25, type: "application/pdf", path: rel, owner: ownerB._id, isBranding: false });

    const attackerForm = await mkForm(null, outsider._id);
    const res = await auth(request(app).get(`/api/upload/file/${attackerForm._id}/x/secret-report.pdf`), outsider);

    const body = Buffer.isBuffer(res.body) ? res.body.toString() : `${res.text ?? ""}${JSON.stringify(res.body ?? "")}`;
    expect(body).not.toContain("TOP-SECRET-VICTIM-CONTENT");
    expect([403, 404]).toContain(res.status);
  });
});

describe("S-05 upload path traversal", () => {
  openHole("formId must not be able to write outside the upload directory", async () => {
    const escapeDir = `escaped-${crypto.randomBytes(4).toString("hex")}`;
    const escapedAbs = path.resolve(uploadDir, "..", escapeDir);
    try {
      const res = await request(app)
        .post(`/api/upload?formId=${encodeURIComponent(`../../${escapeDir}`)}`)
        .set("Authorization", `Bearer ${tok(outsider)}`)
        .attach("logo", Buffer.from("png-bytes"), "logo.png");
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(fs.existsSync(escapedAbs)).toBe(false);
    } finally {
      fs.rmSync(escapedAbs, { recursive: true, force: true });
    }
  });
});

describe("S-07 workspace export download must be tied to the caller's workspace", () => {
  openHole("owner of A must not download B's export by guessing jobId", async () => {
    const exportsDir = path.join(process.cwd(), "uploads", "exports");
    fs.mkdirSync(exportsDir, { recursive: true });
    const file = path.join(exportsDir, `workspace_export_${wsB._id}_${new mongoose.Types.ObjectId()}.json`);
    fs.writeFileSync(file, JSON.stringify({ marker: "B-EXPORT-SECRET" }));
    try {
      const res = await auth(request(app).get("/api/workspaces/current/export/file?jobId=workspace_export_"), ownerA);
      expect(JSON.stringify(res.body) + (res.text ?? "")).not.toContain("B-EXPORT-SECRET");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
