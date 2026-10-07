// QA round (Oct 2026) backend fixes: owner self-grant, trends without formId, Board stage slugs,
// personal exports, role-change session revocation, reviewer tier, dashboard counts.
process.env.JWT_SECRET = "test-jwt-secret-key-for-qa-fixes";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";

jest.mock("../services/report.service", () => ({ generateReportAsync: async () => {}, countReportRows: async () => 0 }));

import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import FormAccessGrant from "../models/FormAccessGrant";
import ResponseModel from "../models/Response";
import SessionModel from "../models/Session";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;
let owner: any, admin: any, reviewer: any, member: any;
let ws: any;
const tok = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: "user" });
const as = (u: any, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${tok(u)}`, "x-workspace-id": ws._id.toString(), ...extra });
const personal = (u: any) => ({ Authorization: `Bearer ${tok(u)}`, "x-workspace-id": "personal" });

const mkForm = (o: Record<string, any> = {}) =>
  Form.create({
    title: "QA form",
    workspaceId: ws._id,
    createdBy: owner._id,
    status: "published",
    fields: [{ fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: false }],
    pages: [{ id: "p1", order: 0, title: "Page" }],
    ...o,
  } as any);

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const mk = (n: string) => User.create({ firebaseUid: `uid-qa-${n}`, fullName: `${n} Q`, email: `${n}@qa.test`, status: "active" });
  [owner, admin, reviewer, member] = await Promise.all(["owner", "admin", "reviewer", "member"].map(mk));
  ws = await Workspace.create({ name: "QA WS", owner: owner._id });
  await Membership.create([
    { userId: owner._id, workspaceId: ws._id, role: "owner" },
    { userId: admin._id, workspaceId: ws._id, role: "admin" },
    { userId: reviewer._id, workspaceId: ws._id, role: "reviewer" },
    { userId: member._id, workspaceId: ws._id, role: "member" },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("form grants", () => {
  it("rejects granting the owner or an admin, and a legacy self-grant never lowers the owner", async () => {
    const f = await mkForm();
    for (const u of [owner, admin]) {
      const res = await request(app).post(`/api/forms/${f._id}/grants`).set(as(owner)).send({ userId: String(u._id), role: "viewer" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("GRANT_TARGET_HAS_FULL_ACCESS");
    }
    // a grant that already exists (created before the guard) must not downgrade the owner or admin
    await FormAccessGrant.create({ formId: f._id, userId: owner._id, role: "viewer" });
    await FormAccessGrant.create({ formId: f._id, userId: admin._id, role: "viewer" });
    expect((await request(app).patch(`/api/forms/${f._id}`).set(as(owner)).send({ title: "Still editable" })).status).toBe(200);
    expect((await request(app).post(`/api/forms/${f._id}/grants`).set(as(admin)).send({ userId: String(member._id), role: "viewer" })).status).toBe(201);
  });

  it("grant by email answers the same for a known and an unknown address", async () => {
    const f = await mkForm();
    const known = await request(app).post(`/api/forms/${f._id}/grants`).set(as(owner)).send({ email: "reviewer@qa.test", role: "viewer" });
    const unknown = await request(app).post(`/api/forms/${f._id}/grants`).set(as(owner)).send({ email: "nobody@qa.test", role: "viewer" });
    expect(known.status).toBe(201);
    expect(unknown.status).toBe(201);
    expect(Object.keys(unknown.body.grant).sort()).toEqual(Object.keys(known.body.grant).sort());
  });
});

describe("analytics trends without formId", () => {
  it("aggregates every form in scope and accepts legacy IANA names", async () => {
    const f = await mkForm();
    await ResponseModel.create([{ formId: f._id, answers: {} }, { formId: f._id, answers: {} }]);
    const res = await request(app).get("/api/analytics/trends?bucket=day&timezone=Asia/Calcutta").set(as(owner));
    expect(res.status).toBe(200);
    expect(res.body.points.reduce((n: number, p: any) => n + p.responses, 0)).toBeGreaterThanOrEqual(2);
  });
});

describe("responses list with a category slug as stageId (Board)", () => {
  it("filters by status instead of 400", async () => {
    const f = await mkForm();
    await ResponseModel.create({ formId: f._id, answers: {}, status: "in_progress" });
    const res = await request(app).get("/api/responses?stageId=in_progress").set(as(owner));
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: any) => r.status === "in_progress")).toBe(true);
  });
});

describe("personal-space reports", () => {
  it("creates, lists and reads a personal export without a workspace", async () => {
    const created = await request(app).post("/api/reports").set(personal(owner)).send({ format: "csv" });
    expect(created.status).toBe(202);
    expect(created.body.report.workspaceId).toBeNull();
    const list = await request(app).get("/api/reports").set(personal(owner));
    expect(list.body.data.map((r: any) => r.id)).toContain(created.body.report.id);
    expect((await request(app).get(`/api/reports/${created.body.report.id}`).set(personal(owner))).status).toBe(200);
    expect((await request(app).get(`/api/reports/${created.body.report.id}`).set(personal(admin))).status).toBe(404);
  });
});

describe("role changes", () => {
  it("revokes sessions only when access is lowered", async () => {
    const mkSession = () => SessionModel.create({ userId: member._id, ipHash: "abc" });
    const active = () => SessionModel.countDocuments({ userId: member._id, $or: [{ revokedAt: null }, { revokedAt: { $exists: false } }] });
    const change = (role: string) => request(app).patch(`/api/workspaces/${ws._id}/members/${member._id}`).set(as(owner)).send({ role });
    await mkSession();
    expect((await change("member")).status).toBe(200); // same role
    expect(await active()).toBe(1);
    expect((await change("admin")).status).toBe(200); // promotion
    expect(await active()).toBe(1);
    expect((await change("viewer")).status).toBe(200); // demotion
    expect(await active()).toBe(0);
    await Membership.updateOne({ userId: member._id, workspaceId: ws._id }, { role: "member" });
  });
});

describe("reviewer tier and dashboard counts", () => {
  it("reviewer can change a response but not delete it", async () => {
    const f = await mkForm();
    const r = await ResponseModel.create({ formId: f._id, answers: {} });
    expect((await request(app).patch(`/api/responses/${r._id}`).set(as(reviewer)).send({ status: "in_progress" })).status).toBe(200);
    expect((await request(app).delete(`/api/responses/${r._id}`).set(as(reviewer))).status).toBe(403);
  });

  it("dashboard analytics carries uncapped counts by status", async () => {
    const res = await request(app).get("/api/dashboard/analytics").set(as(owner));
    expect(res.status).toBe(200);
    const { counts, totalForms, totalResponses } = res.body.analytics;
    expect(counts.forms.total).toBe(totalForms);
    expect(counts.responses.total).toBe(totalResponses);
    expect(counts.responses.new + counts.responses.in_progress + counts.responses.completed).toBe(totalResponses);
  });
});
