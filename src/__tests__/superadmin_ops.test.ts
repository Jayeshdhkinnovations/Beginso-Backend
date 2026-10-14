// Operator-console surfaces: storage, workspaces, built-in templates, per-user sessions, health, exports,
// and the shared-cascade delete of an admin account.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Template from "../models/Template";
import SessionModel from "../models/Session";
import ReportModel from "../models/Report";
import Invitation from "../models/Invitation";
import { AuditLog } from "../models/AuditLog";
import { generateToken } from "../utils/generateToken";
import { MB } from "../services/storage.service";
import { resetFrontendBuildCache } from "../services/superadminOps.service";
import { parseAuditSummary, loadAuditInfo } from "../utils/auditInfo";

process.env.JWT_SECRET = "test-jwt-secret-key-for-superadmin-ops";

jest.mock("../services/reportQueue", () => ({ kickReportQueue: jest.fn(), recoverReportQueue: jest.fn() }));
jest.mock("../config/firebase", () => ({
  auth: { deleteUser: jest.fn().mockResolvedValue(undefined), updateUser: jest.fn().mockResolvedValue(undefined) },
  revokeFirebaseUserTokens: jest.fn().mockResolvedValue(undefined),
}));

let mongoServer: MongoMemoryServer;
let sa: string;
let owner: any;
let member: any;
let ws: any;

const tokenOf = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role });
const get = (url: string, token = sa) => request(app).get(url).set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User, Workspace, Membership, Form, ResponseModel, Template, SessionModel, ReportModel, Invitation].map((m: any) => m.init()));
});

beforeEach(async () => {
  await Promise.all([User, Workspace, Membership, Form, ResponseModel, Template, SessionModel, ReportModel, Invitation].map((m: any) => m.deleteMany({})));
  await AuditLog.collection.deleteMany({}); // the model refuses mutation by design
  const admin = await User.create({ firebaseUid: "sa", fullName: "SA", email: "sa@ops.test", role: "super_admin", status: "active" });
  sa = tokenOf(admin);
  owner = await User.create({ firebaseUid: "own", fullName: "Owner", email: "own@ops.test", role: "admin", status: "active" });
  member = await User.create({ firebaseUid: "mem", fullName: "Member", email: "mem@ops.test", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "Acme", slug: "acme", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  await Membership.create({ userId: member._id, workspaceId: ws._id, role: "editor" });
  await User.updateOne({ _id: owner._id }, { $set: { workspaceId: ws._id } });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("auth", () => {
  it("every new route is super-admin only", async () => {
    const normal = tokenOf(owner);
    for (const url of ["/api/superadmin/storage", "/api/superadmin/workspaces", "/api/superadmin/templates", "/api/superadmin/health", "/api/superadmin/exports"]) {
      expect((await get(url, normal)).status).toBe(403);
      expect((await request(app).get(url)).status).toBe(401);
    }
  });
});

describe("storage", () => {
  it("returns totals and rows, worst first, with a three-way state", async () => {
    await User.updateOne({ _id: owner._id }, { $set: { storageUsedBytes: 700 * MB } });
    await User.updateOne({ _id: member._id }, { $set: { storageUsedBytes: 550 * MB } });
    const res = await get("/api/superadmin/storage");
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ totalStorageUsed: 1250 * MB, overQuota: 2, overCeiling: 1 });
    expect(res.body.data.map((r: any) => [r.email, r.state])).toEqual([
      ["own@ops.test", "over_ceiling"],
      ["mem@ops.test", "over_quota"],
    ]);
    expect(res.body.data[0]).toMatchObject({ workspaceCount: 1, workspaceLimit: 10 });
    expect(res.body.pagination).toMatchObject({ total: 2, page: 1 });
  });

  it("filters by state and searches by email", async () => {
    await User.updateOne({ _id: member._id }, { $set: { storageUsedBytes: 550 * MB } });
    expect((await get("/api/superadmin/storage?state=over_quota")).body.data).toHaveLength(1);
    expect((await get("/api/superadmin/storage?state=over_ceiling")).body.data).toHaveLength(0);
    expect((await get("/api/superadmin/storage?search=own@")).body.data).toHaveLength(1);
  });
});

describe("workspaces", () => {
  it("lists with owner, member and form counts, and shows a detail view", async () => {
    await Form.create({ title: "F", workspaceId: ws._id, createdBy: owner._id, slug: "f1" });
    const list = await get("/api/superadmin/workspaces");
    expect(list.body.data[0]).toMatchObject({ name: "Acme", memberCount: 2, formCount: 1, owner: { email: "own@ops.test" } });
    expect((await get("/api/superadmin/workspaces?search=zzz")).body.data).toHaveLength(0);

    const detail = await get(`/api/superadmin/workspaces/${ws._id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.members.map((m: any) => m.role).sort()).toEqual(["editor", "owner"]);
    expect(detail.body.usage.formCount).toBe(1);
    expect((await get(`/api/superadmin/workspaces/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
  });

  it("deletes through the shared cascade only when the exact name is typed, and audits it", async () => {
    const form: any = await Form.create({ title: "F", workspaceId: ws._id, createdBy: owner._id, slug: "f2" });
    await ResponseModel.create({ formId: form._id, answers: { a: "b" } });
    const wrong = await request(app).delete(`/api/superadmin/workspaces/${ws._id}`).set("Authorization", `Bearer ${sa}`).send({ confirm: "acme" });
    expect(wrong.status).toBe(422);
    expect(await Workspace.countDocuments({ _id: ws._id })).toBe(1);

    const ok = await request(app).delete(`/api/superadmin/workspaces/${ws._id}`).set("Authorization", `Bearer ${sa}`).send({ confirm: "Acme" });
    expect(ok.status).toBe(200);
    expect(await Workspace.countDocuments({ _id: ws._id })).toBe(0);
    expect(await Form.countDocuments({ workspaceId: ws._id })).toBe(0);
    expect(await ResponseModel.countDocuments({})).toBe(0);
    expect(await Membership.countDocuments({ workspaceId: ws._id })).toBe(0);
    expect(await AuditLog.countDocuments({ action: "workspace.delete" })).toBe(1);
  });
});

describe("built-in templates", () => {
  const base = { name: "Contact", category: "general", theme: "classic-light", fields: [] };

  it("never lists, edits or deletes a workspace-published template", async () => {
    const wsTemplate: any = await Template.create({ ...base, name: "Theirs", workspaceId: ws._id });
    await Template.create({ ...base, name: "Ours", workspaceId: null });
    const list = await get("/api/superadmin/templates");
    expect(list.body.data.map((t: any) => t.name)).toEqual(["Ours"]);

    expect((await request(app).patch(`/api/superadmin/templates/${wsTemplate._id}`).set("Authorization", `Bearer ${sa}`).send({ name: "Hacked" })).status).toBe(404);
    expect((await request(app).delete(`/api/superadmin/templates/${wsTemplate._id}`).set("Authorization", `Bearer ${sa}`).send({ confirm: "Theirs" })).status).toBe(404);
    expect(await Template.findById(wsTemplate._id).lean()).toMatchObject({ name: "Theirs" });
  });

  it("creates built-in templates only (a workspaceId in the body is ignored), edits and deletes with type-to-confirm", async () => {
    const created = await request(app).post("/api/superadmin/templates").set("Authorization", `Bearer ${sa}`).send({ ...base, workspaceId: String(ws._id) });
    expect(created.status).toBe(201);
    const id = created.body.template.id;
    expect((await Template.findById(id).lean())!.workspaceId).toBeNull();

    const edited = await request(app).patch(`/api/superadmin/templates/${id}`).set("Authorization", `Bearer ${sa}`).send({ category: "hr" });
    expect(edited.body.template.category).toBe("hr");

    expect((await request(app).delete(`/api/superadmin/templates/${id}`).set("Authorization", `Bearer ${sa}`).send({ confirm: "nope" })).status).toBe(422);
    expect((await request(app).delete(`/api/superadmin/templates/${id}`).set("Authorization", `Bearer ${sa}`).send({ confirm: "Contact" })).status).toBe(200);
    expect(await Template.countDocuments({ _id: id })).toBe(0);
    expect(await AuditLog.countDocuments({ action: { $in: ["template.create", "template.edit", "template.delete"] } })).toBe(3);
  });

  it("counts how many forms were created from each template", async () => {
    const t: any = await Template.create({ ...base, workspaceId: null });
    await Form.create({ title: "A", workspaceId: ws._id, createdBy: owner._id, slug: "ta", templateId: t._id });
    await Form.create({ title: "B", workspaceId: ws._id, createdBy: owner._id, slug: "tb", templateId: t._id });
    expect((await get("/api/superadmin/templates")).body.data[0].usageCount).toBe(2);
  });
});

describe("sessions of one user", () => {
  const mkSession = (userId: any) => SessionModel.create({ userId, deviceLabel: "Chrome on Windows", userAgent: "x", ipHash: "h", lastActiveAt: new Date() });

  it("lists and revokes a single session, and refuses another account's session id", async () => {
    const mine: any = await mkSession(owner._id);
    const theirs: any = await mkSession(member._id);
    const list = await get(`/api/superadmin/admins/${owner._id}/sessions`);
    expect(list.body.sessions).toHaveLength(1);

    const cross = await request(app).delete(`/api/superadmin/admins/${owner._id}/sessions/${theirs._id}`).set("Authorization", `Bearer ${sa}`);
    expect(cross.status).toBe(404);
    expect((await SessionModel.findById(theirs._id).lean())!.revokedAt).toBeFalsy();

    expect((await request(app).delete(`/api/superadmin/admins/${owner._id}/sessions/${mine._id}`).set("Authorization", `Bearer ${sa}`)).status).toBe(200);
    expect((await SessionModel.findById(mine._id).lean())!.revokedAt).toBeTruthy();
  });

  it("revokes every active session at once", async () => {
    await mkSession(owner._id);
    await mkSession(owner._id);
    const res = await request(app).delete(`/api/superadmin/admins/${owner._id}/sessions`).set("Authorization", `Bearer ${sa}`);
    expect(res.body.revoked).toBe(2);
    expect((await get(`/api/superadmin/admins/${owner._id}/sessions`)).body.sessions).toHaveLength(0);
    expect(await AuditLog.countDocuments({ action: "session.revoke" })).toBe(1);
  });
});

describe("user detail and stats", () => {
  it("detail lists the workspaces the user belongs to, with role and member count", async () => {
    const res = await get(`/api/superadmin/admins/${member._id}`);
    expect(res.body.workspaces).toEqual([{ id: String(ws._id), name: "Acme", role: "editor", memberCount: 2 }]);
  });

  it("stats include the template count", async () => {
    await Template.create({ name: "T", category: "c", theme: "t", fields: [], workspaceId: null });
    expect((await get("/api/superadmin/stats")).body.stats.totalTemplates).toBe(1);
  });
});

describe("deleting an admin goes through the shared account cascade", () => {
  it("removes every owned workspace, memberships elsewhere, invitations and sessions", async () => {
    const second: any = await Workspace.create({ name: "Second", slug: "second", timezone: "UTC", owner: owner._id });
    await Membership.create({ userId: owner._id, workspaceId: second._id, role: "owner" });
    // The old cascade only cleared user.workspaceId; a second owned workspace and a membership elsewhere were orphaned.
    const other: any = await Workspace.create({ name: "Other", slug: "other", timezone: "UTC", owner: member._id });
    await Membership.create({ userId: member._id, workspaceId: other._id, role: "owner" });
    await Membership.create({ userId: owner._id, workspaceId: other._id, role: "viewer" });
    await SessionModel.create({ userId: owner._id, deviceLabel: "d", userAgent: "x", ipHash: "h", lastActiveAt: new Date() });
    await Invitation.create({ workspaceId: other._id, email: "own@ops.test", role: "viewer", status: "pending", tokenHash: "tok", invitedBy: member._id, expiresAt: new Date(Date.now() + 1e6) });
    expect(await Invitation.countDocuments({ email: "own@ops.test" })).toBe(1);

    const res = await request(app).delete(`/api/superadmin/admins/${owner._id}`).set("Authorization", `Bearer ${sa}`).send({ confirm: "own@ops.test" });
    expect(res.status).toBe(200);
    expect(res.body.cascadeResult).toMatchObject({ userDeleted: true, workspaceDeleted: true });
    expect(await Workspace.countDocuments({ owner: owner._id })).toBe(0);
    expect(await Membership.countDocuments({ userId: owner._id })).toBe(0);
    expect(await SessionModel.countDocuments({ userId: owner._id })).toBe(0);
    expect(await Invitation.countDocuments({ email: "own@ops.test" })).toBe(0);
    expect(await Workspace.countDocuments({ _id: other._id })).toBe(1); // someone else's workspace stays
  });
});

describe("health", () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    resetFrontendBuildCache();
  });

  it("reports build info, queue depth and SMTP TLS, and the frontend build and audit when it publishes them", async () => {
    await ReportModel.create({ workspaceId: null, format: "csv", status: "queued", expiresAt: new Date(Date.now() + 1e6) });
    await ReportModel.create({ workspaceId: null, format: "csv", status: "failed", expiresAt: new Date(Date.now() + 1e6) });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ commit: "abc1234", commitMessage: "Add things", builtAt: "2026-10-14T08:00:00.000Z", audit: { total: 2, critical: 0, high: 1, checkedAt: "2026-10-14T08:00:00.000Z" } }),
    }) as any;
    const res = await get("/api/superadmin/health");
    expect(res.status).toBe(200);
    expect(res.body.reportQueue).toEqual({ queued: 1, processing: 0, failed: 1 });
    expect(res.body.smtp.tlsVerification).toBe(true);
    expect(res.body.backend).toHaveProperty("commit");
    expect(res.body.frontend).toEqual({ commit: "abc1234", commitMessage: "Add things", builtAt: "2026-10-14T08:00:00.000Z" });
    expect(res.body.dependencyVulnerabilities.frontend).toMatchObject({ total: 2, high: 1 });
    expect(res.body.dependencyVulnerabilities).toHaveProperty("backend");
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toMatch(/\/build-info\.json$/);
  });

  it("says nothing is recorded (null) when the frontend cannot be reached or answers garbage", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as any;
    const down = await get("/api/superadmin/health");
    expect(down.status).toBe(200);
    expect(down.body.frontend).toBeNull();
    expect(down.body.dependencyVulnerabilities.frontend).toBeNull();

    resetFrontendBuildCache();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ commit: 5, audit: { total: "x" } }) }) as any;
    const odd = await get("/api/superadmin/health");
    expect(odd.body.frontend).toEqual({ commit: null, commitMessage: null, builtAt: null });
    expect(odd.body.dependencyVulnerabilities.frontend).toBeNull();
  });

  it("caches the frontend answer for five minutes", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ commit: "abc1234" }) }) as any;
    await get("/api/superadmin/health");
    await get("/api/superadmin/health");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("audit summary parsing", () => {
  it("accepts a complete summary and rejects anything else", () => {
    expect(parseAuditSummary({ total: 3, critical: 1, high: 2, checkedAt: "2026-10-14" })).toEqual({ total: 3, critical: 1, high: 2, checkedAt: "2026-10-14" });
    expect(parseAuditSummary({ total: 3 })).toBeNull();
    expect(parseAuditSummary(null)).toBeNull();
    expect(loadAuditInfo("D:/no/such/audit.json")).toBeNull();
  });
});

describe("exports", () => {
  it("lists jobs and requeues only failed ones", async () => {
    const failed: any = await ReportModel.create({ workspaceId: null, requestedBy: owner._id, format: "pdf", status: "failed", errorMessage: "boom", expiresAt: new Date(Date.now() + 1e6) });
    const done: any = await ReportModel.create({ workspaceId: null, format: "csv", status: "completed", expiresAt: new Date(Date.now() + 1e6) });
    const list = await get("/api/superadmin/exports?status=failed");
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ errorMessage: "boom", requestedBy: { email: "own@ops.test" }, workspaceName: "Personal" });

    expect((await request(app).post(`/api/superadmin/exports/${done._id}/retry`).set("Authorization", `Bearer ${sa}`)).status).toBe(404);
    expect((await request(app).post(`/api/superadmin/exports/${failed._id}/retry`).set("Authorization", `Bearer ${sa}`)).status).toBe(200);
    expect(["queued", "processing", "completed", "failed"]).toContain((await ReportModel.findById(failed._id).lean())!.status);
    expect(await AuditLog.countDocuments({ action: "report.retry" })).toBe(1);
  });
});
