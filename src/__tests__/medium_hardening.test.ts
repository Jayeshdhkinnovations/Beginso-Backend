// Medium-severity hardening from the September 2026 audit (S-24, S-26, S-31 to S-35, text search).
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import crypto from "crypto";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Invitation from "../models/Invitation";
import FormAccessGrant from "../models/FormAccessGrant";
import Report from "../models/Report";
import SessionModel from "../models/Session";
import { Event } from "../models/Event";
import { generateToken } from "../utils/generateToken";
import { errorHandler } from "../middleware/error.middleware";
import { hashIp } from "../utils/ip";
import { buildSearchText } from "../utils/responseSearch";
import { safeTimezone, escapeRegex } from "../utils/safeInput";
import { FormService } from "../services/form.service";
import { ResponseService } from "../services/response.service";
import { superAdminService } from "../services/superadmin.service";

process.env.JWT_SECRET = "test-jwt-secret-key-for-medium-hardening-suite";

let mongoServer: MongoMemoryServer;
let owner: any;
let admin: any;
let admin2: any;
let editor: any;
let wsMain: any;
let wsOther: any;

const tok = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role });
const as = (r: request.Test, u: any) => r.set("Authorization", `Bearer ${tok(u)}`).set("x-workspace-id", wsMain._id.toString());
const mkUser = (key: string) => User.create({ firebaseUid: `uid-med-${key}`, fullName: key, email: `${key}@med.test`, role: "admin", status: "active" });
const mkForm = (workspaceId: any, createdBy: any, extra: any = {}) =>
  Form.create({
    title: `f-${crypto.randomBytes(3).toString("hex")}`,
    workspaceId,
    createdBy,
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
    ...extra,
  });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User, Workspace, Membership, Form, ResponseModel, Invitation, FormAccessGrant, Report, SessionModel, Event].map((m: any) => m.init()));
});

beforeEach(async () => {
  await Promise.all([Form, ResponseModel, Invitation, FormAccessGrant, Report, SessionModel, Membership].map((m: any) => m.deleteMany({})));
  await Event.collection.deleteMany({});
  await Workspace.deleteMany({});
  await User.deleteMany({});
  owner = await mkUser("owner");
  admin = await mkUser("admin");
  admin2 = await mkUser("admin2");
  editor = await mkUser("editor");
  wsMain = await Workspace.create({ name: "Main", slug: "main-med", timezone: "UTC", owner: owner._id });
  wsOther = await Workspace.create({ name: "Other", slug: "other-med", timezone: "UTC", owner: owner._id });
  await User.updateOne({ _id: owner._id }, { $set: { workspaceId: wsMain._id } });
  await Membership.create([
    { userId: owner._id, workspaceId: wsMain._id, role: "owner" },
    { userId: admin._id, workspaceId: wsMain._id, role: "admin" },
    { userId: admin2._id, workspaceId: wsMain._id, role: "admin" },
    { userId: editor._id, workspaceId: wsMain._id, role: "editor" },
    { userId: owner._id, workspaceId: wsOther._id, role: "owner" },
    { userId: admin._id, workspaceId: wsOther._id, role: "admin" },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("S-24 admins cannot act on peer admins", () => {
  const patchRole = (target: any, by: any, role: string) =>
    as(request(app).patch(`/api/workspaces/${wsMain._id}/members/${target._id}`), by).send({ role });

  it("an admin cannot demote, promote to, or remove another admin", async () => {
    const demote = await patchRole(admin2, admin, "viewer");
    expect(demote.status).toBe(403);
    expect(demote.body.error.code).toBe("ADMIN_REQUIRES_OWNER");
    expect((await patchRole(editor, admin, "admin")).status).toBe(403);
    const remove = await as(request(app).delete(`/api/workspaces/${wsMain._id}/members/${admin2._id}`), admin);
    expect(remove.status).toBe(403);
    expect(await Membership.countDocuments({ userId: admin2._id, workspaceId: wsMain._id })).toBe(1);
  });

  it("an admin still manages editors, and the owner can manage admins", async () => {
    expect((await patchRole(editor, admin, "viewer")).status).toBe(200);
    expect((await patchRole(admin2, owner, "editor")).status).toBe(200);
    expect((await as(request(app).delete(`/api/workspaces/${wsMain._id}/members/${admin._id}`), owner)).status).toBe(200);
  });
});

describe("S-26 moving and duplicating forms", () => {
  it("an editor cannot move a form; an owner/admin of both sides can", async () => {
    const form = await mkForm(wsMain._id, editor._id);
    const denied = await as(request(app).post(`/api/forms/${form._id}/move`), editor).send({ targetWorkspaceId: wsOther._id.toString() });
    expect(denied.status).toBe(403);
    const ok = await as(request(app).post(`/api/forms/${form._id}/move`), admin).send({ targetWorkspaceId: wsOther._id.toString() });
    expect(ok.status).toBe(200);
  });

  it("moving to personal makes the mover the owner and drops old shares", async () => {
    const form = await mkForm(wsMain._id, editor._id);
    await FormAccessGrant.create({ formId: form._id, userId: editor._id, role: "viewer", grantedBy: owner._id });
    const res = await as(request(app).post(`/api/forms/${form._id}/move`), admin).send({ targetWorkspaceId: "personal" });
    expect(res.status).toBe(200);
    const moved: any = await Form.findById(form._id);
    expect(String(moved.createdBy)).toBe(String(admin._id));
    expect(moved.workspaceId).toBeNull();
    expect(await FormAccessGrant.countDocuments({ formId: form._id })).toBe(0);
  });

  it("a duplicate belongs to whoever duplicated it", async () => {
    const form = await mkForm(wsMain._id, owner._id);
    const res = await as(request(app).post(`/api/forms/${form._id}/duplicate`), editor);
    expect(res.status).toBe(201);
    const copy: any = await Form.findById(res.body._id);
    expect(String(copy.createdBy)).toBe(String(editor._id));
  });
});

describe("S-27 / S-28 hashing", () => {
  it("IP hashes are keyed, not a plain SHA-256", () => {
    const plain = crypto.createHash("sha256").update("203.0.113.9").digest("hex");
    expect(hashIp("203.0.113.9")).not.toBe(plain);
    expect(hashIp("203.0.113.9")).toBe(hashIp("203.0.113.9"));
  });
});

describe("S-32 error responses", () => {
  const run = (err: any) => {
    const out: any = {};
    const res: any = { status: (c: number) => ((out.status = c), res), json: (b: any) => ((out.body = b), res) };
    errorHandler(err, { method: "GET", ip: "1.1.1.1", originalUrl: "/x", headers: { cookie: "secret" }, query: {}, body: {} } as any, res, () => {});
    return out;
  };

  it("a 5xx never returns the internal message", () => {
    const out = run(new Error("E11000 duplicate key error collection: prod.users index: email_1 dup key: { email: \"a@b.c\" }"));
    expect(out.status).toBe(500);
    expect(out.body.message).toBe("Internal Server Error");
    expect(JSON.stringify(out.body)).not.toMatch(/E11000|dup key/);
  });

  it("a 4xx keeps its message", () => {
    expect(run(Object.assign(new Error("Nope"), { statusCode: 403 })).body.message).toBe("Nope");
  });

  it("a bad id does not echo the value back", async () => {
    const res = await as(request(app).get("/api/forms/not-an-id"), owner);
    expect([400, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain("not-an-id");
  });
});

describe("S-33 bounded lists and safe input", () => {
  it("the form list caps limit at 50, counts responses in one query, and survives regex characters", async () => {
    const form = await mkForm(wsMain._id, owner._id, { title: "Budget (2026) [draft]" });
    await ResponseModel.create([{ formId: form._id, answers: {} }, { formId: form._id, answers: {} }]);
    const res = await as(request(app).get("/api/forms").query({ limit: 1000, search: "(2026) [" }), owner);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.forms).toHaveLength(1);
    expect(res.body.forms[0].responseCount).toBe(2);
    expect((await as(request(app).get("/api/forms?search=a&search=b"), owner)).status).toBe(200);
  });

  it("an unknown timezone falls back to UTC instead of a 500", async () => {
    expect(safeTimezone("Not/AZone")).toBe("UTC");
    expect(safeTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
    const form = await mkForm(wsMain._id, owner._id);
    const res = await as(request(app).get("/api/analytics/trends"), owner).query({ formId: String(form._id), timezone: "Not/AZone" });
    expect(res.status).toBe(200);
  });

  it("escapeRegex neutralises every metacharacter", () => {
    expect(new RegExp(escapeRegex("a.b*c(d)")).test("a.b*c(d)")).toBe(true);
    expect(new RegExp(escapeRegex("a.b")).test("axb")).toBe(false);
  });
});

describe("S-34 atomic writes", () => {
  it("parallel submissions cannot overshoot the response limit", async () => {
    const form: any = await mkForm(wsMain._id, owner._id, {
      status: "published",
      publishedSlug: "limit-form",
      settings: { responseLimitEnabled: true, responseLimit: 2 },
    });
    const svc = new FormService();
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => svc.submitForm(String(form._id), { Name: `n${i}` })));
    const stored = await ResponseModel.countDocuments({ formId: form._id });
    expect(stored).toBeLessThanOrEqual(2);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(stored);
  });

  it("only one pending invitation per workspace and email can exist", async () => {
    const base = { workspaceId: wsMain._id, email: "dup@med.test", role: "viewer" as const, status: "pending" as const, expiresAt: new Date(Date.now() + 1e6), invitedBy: owner._id };
    await Invitation.create({ ...base, token: "t1" });
    await expect(Invitation.create({ ...base, token: "t2" })).rejects.toMatchObject({ code: 11000 });
    await Invitation.create({ ...base, token: "t3", status: "revoked" });
  });

  it("a workspace is removed again if its owner membership cannot be written", async () => {
    const spy = jest.spyOn(Membership, "create").mockRejectedValueOnce(new Error("boom") as never);
    const res = await as(request(app).post("/api/workspaces"), owner).send({ name: "Half made", slug: "half-made" });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await Workspace.countDocuments({ slug: "half-made" })).toBe(0);
  });
});

describe("S-35 reports", () => {
  it("another workspace's form title is never returned, and the queue is capped", async () => {
    const foreign = await Workspace.create({ name: "Foreign", slug: "foreign-med", timezone: "UTC", owner: editor._id });
    const foreignForm = await mkForm(foreign._id, editor._id, { title: "Top secret form" });
    const created = await as(request(app).post("/api/reports"), owner).send({ format: "csv", formId: String(foreignForm._id) });
    expect(created.status).toBe(202);
    expect(JSON.stringify(created.body)).not.toContain("Top secret");

    await Report.deleteMany({});
    for (let i = 0; i < 3; i++) {
      await Report.create({ workspaceId: wsMain._id, format: "csv", filters: {}, status: "processing", expiresAt: new Date(Date.now() + 1e6) });
    }
    const full = await as(request(app).post("/api/reports"), owner).send({ format: "csv" });
    expect(full.status).toBe(429);
    expect(full.body.error.code).toBe("REPORT_QUEUE_FULL");
  });
});

describe("response search", () => {
  it("finds new responses in the database and legacy ones by the fallback scan, regex-safe", async () => {
    const form: any = await mkForm(wsMain._id, owner._id, { status: "published", publishedSlug: "search-form" });
    await new FormService().submitForm(String(form._id), { Name: "Alice (Sales)" });
    await ResponseModel.collection.insertOne({ formId: form._id, answers: { Name: "Legacy Alice" }, status: "new", submittedAt: new Date() });
    await ResponseModel.create({ formId: form._id, answers: { Name: "Bob" }, searchText: buildSearchText({ Name: "Bob" }) });

    const svc = new ResponseService();
    const alice = await svc.getResponses({ workspaceId: String(wsMain._id), formId: String(form._id), search: "alice" });
    expect(alice.total).toBe(2);
    expect((await svc.getResponses({ workspaceId: String(wsMain._id), formId: String(form._id), search: "(sales)" })).total).toBe(1);
    expect((await svc.getResponses({ workspaceId: String(wsMain._id), formId: String(form._id), search: ".*" })).total).toBe(0);
  });

  it("searchText flattens values, arrays and file names", () => {
    expect(buildSearchText({ a: "Hello", b: ["X", "Y"], c: { fileName: "cv.pdf", secret: "ignored" }, d: 5 })).toBe("hello x y cv.pdf 5");
  });
});

describe("S-31 suspension ends sessions", () => {
  it("suspending a user through the super-admin service revokes their sessions", async () => {
    const boss = await User.create({ firebaseUid: "uid-med-boss", fullName: "boss", email: "boss@med.test", role: "super_admin", status: "active" });
    const s = await SessionModel.create({ userId: editor._id, deviceLabel: "x", userAgent: "x", ipHash: "x", lastActiveAt: new Date() });
    await superAdminService.updateAdmin({ id: String(boss._id), email: boss.email, fullName: boss.fullName }, String(editor._id), { status: "suspended" });
    expect((await SessionModel.findById(s._id))?.revokedAt).toBeTruthy();
  });
});

describe("S-29 CORS allows only exact origins", () => {
  const acao = async (origin: string) => (await request(app).get("/").set("Origin", origin)).headers["access-control-allow-origin"];

  it("allows the real frontends and refuses look-alikes and wildcard hosts", async () => {
    expect(await acao("https://beginso.com")).toBe("https://beginso.com");
    expect(await acao("https://admin.beginso.com")).toBe("https://admin.beginso.com");
    expect(await acao("https://beginso.vercel.app")).toBe("https://beginso.vercel.app");
    expect(await acao("https://evil.vercel.app")).toBeUndefined();
    expect(await acao("https://www.beginso.com")).toBe("https://www.beginso.com");
    expect(await acao("https://app.beginso.com")).toBeUndefined();
    expect(await acao("https://anything.dhkinnovations.com")).toBeUndefined();
    expect(await acao("https://random.beginso.com")).toBeUndefined();
    expect(await acao("https://beginso.com.evil.com")).toBeUndefined();
  });

  it("still answers requests that carry no Origin (the frontend proxy, curl)", async () => {
    expect((await request(app).get("/")).status).toBe(200);
  });
});

describe("legacy workspace fallback (V1 users without a Membership row)", () => {
  it("having a workspace as default no longer makes a non-member an admin", async () => {
    const stranger = await mkUser("stranger");
    await User.updateOne({ _id: stranger._id }, { $set: { workspaceId: wsMain._id } });
    const members = await as(request(app).get(`/api/workspaces/${wsMain._id}/members`), stranger);
    expect(members.status).toBe(403);
    const invite = await as(request(app).post(`/api/workspaces/${wsMain._id}/invitations`), stranger).send({ email: "x@med.test", role: "admin" });
    expect(invite.status).toBe(403);
  });

  it("a workspace owner without a Membership row keeps working and gets the row created", async () => {
    const legacyOwner = await mkUser("legacyowner");
    const ws = await Workspace.create({ name: "V1", slug: "v1-med", timezone: "UTC", owner: legacyOwner._id });
    await User.updateOne({ _id: legacyOwner._id }, { $set: { workspaceId: ws._id } });
    expect(await Membership.countDocuments({ workspaceId: ws._id })).toBe(0);
    const res = await request(app).get(`/api/workspaces/${ws._id}/members`).set("Authorization", `Bearer ${tok(legacyOwner)}`);
    expect(res.status).toBe(200);
    const row: any = await Membership.findOne({ userId: legacyOwner._id, workspaceId: ws._id });
    expect(row?.role).toBe("owner");
  });

  it("someone who created a workspace form and was then removed loses access to it", async () => {
    const form = await mkForm(wsMain._id, editor._id);
    expect((await as(request(app).get(`/api/forms/${form._id}`), editor)).status).toBe(200);
    await Membership.deleteOne({ userId: editor._id, workspaceId: wsMain._id });
    expect((await as(request(app).get(`/api/forms/${form._id}`), editor)).status).toBe(403);
  });
});

describe("S-21 provisioned admins and S-22 regex input", () => {
  const actor = () => ({ id: String(owner._id), email: "boss@med.test", fullName: "boss" });

  it("a new admin gets a random password, never the old fixed one", async () => {
    const { auth } = require("../config/firebase");
    const spy = jest.spyOn(auth, "createUser").mockResolvedValue({ uid: "uid-new-admin" } as never);
    await superAdminService.createAdmin(actor(), { name: "New Admin", email: "newadmin@med.test", workspaceName: "Fresh" });
    const password = (spy.mock.calls[0][0] as any).password as string;
    spy.mockRestore();
    expect(password).not.toBe("TempPassword123!");
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(await User.findOne({ email: "newadmin@med.test" })).toBeTruthy();
  });

  it("an email that already has a login, or a Firebase failure, creates nothing", async () => {
    const { auth } = require("../config/firebase");
    const exists = jest.spyOn(auth, "createUser").mockRejectedValue(Object.assign(new Error("exists"), { code: "auth/email-already-exists" }) as never);
    await expect(superAdminService.createAdmin(actor(), { name: "A", email: "dupe@med.test", workspaceName: "W" })).rejects.toThrow(/already exists/);
    exists.mockRestore();
    const broken = jest.spyOn(auth, "createUser").mockRejectedValue(new Error("network") as never);
    await expect(superAdminService.createAdmin(actor(), { name: "B", email: "broken@med.test", workspaceName: "W" })).rejects.toThrow(/Nothing was created/);
    broken.mockRestore();
    expect(await User.countDocuments({ email: { $in: ["dupe@med.test", "broken@med.test"] } })).toBe(0);
  });

  it("super-admin search boxes treat regex characters literally", async () => {
    await expect(superAdminService.getAdmins({ search: "(unclosed[" } as any)).resolves.toBeDefined();
  });
});

describe("clean-up: one error envelope, totalPages, no owner invitations", () => {
  it("every failed response carries error.message, even from handlers that only set message", async () => {
    const noAuth = await request(app).get("/api/forms");
    expect(noAuth.status).toBe(401);
    expect(typeof noAuth.body.error?.message).toBe("string");
    const missing = await as(request(app).get(`/api/forms/${new mongoose.Types.ObjectId()}`), owner);
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(typeof missing.body.error?.message).toBe("string");
  });

  it("GET /api/forms returns totalPages as well as pages", async () => {
    await mkForm(wsMain._id, owner._id);
    const res = await as(request(app).get("/api/forms"), owner);
    expect(res.body.totalPages).toBe(res.body.pages);
  });

  it("an invitation or a form share can no longer be created with the owner role", async () => {
    const res = await as(request(app).post(`/api/workspaces/${wsMain._id}/invitations`), owner).send({ email: "o@med.test", role: "owner" });
    expect(res.status).toBe(400);
    await expect(Invitation.create({ workspaceId: wsMain._id, email: "x@med.test", role: "owner", status: "pending", token: "tk-owner", expiresAt: new Date(Date.now() + 1e6), invitedBy: owner._id } as any)).rejects.toThrow();
  });
});
