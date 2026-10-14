// Per-user storage quota: the running counter, the enforcement table, Trash, and reconciliation.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import app from "../app";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Notification from "../models/Notification";
import { AuditLog } from "../models/AuditLog";
import { clearRateLimitStore } from "../middleware/rateLimiter";
import { generateToken } from "../utils/generateToken";
import { MB, bsonSize, computeTrueUsage, reconcileUser, reconcileAllStorage } from "../services/storage.service";
import { purgeItem, emptyTrash } from "../services/trash.service";

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "beginso-quota-"));
process.env.UPLOAD_DIR = uploadDir;
process.env.JWT_SECRET = "test-jwt-secret-key-for-storage-quota";

let mongoServer: MongoMemoryServer;
let owner: any;
let member: any;
let ws: any;

const used = async (u: any = owner): Promise<number> => (await User.findById(u._id).lean())!.storageUsedBytes;
const setUsed = (bytes: number, u: any = owner) => User.updateOne({ _id: u._id }, { $set: { storageUsedBytes: bytes } });
const tokenOf = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role });
const scope = () => ({ workspaceId: ws._id.toString(), userId: owner._id.toString(), userEmail: owner.email, userName: "Owner", role: "owner" as const });

const mkForm = (extra: any = {}) =>
  Form.create({
    title: "Quota",
    workspaceId: ws._id,
    createdBy: owner._id,
    status: "published",
    slug: `q-${Math.random().toString(36).slice(2, 8)}`,
    publishedSlug: `q-${Math.random().toString(36).slice(2, 8)}`,
    fields: [
      { fieldId: "name", label: "Name", type: "short_text", required: true },
      { fieldId: "cv", label: "CV", type: "file_upload", required: true },
    ],
    ...extra,
  });

// Trash metadata (deletedAt / deletedBy) is a few bytes that the counter deliberately ignores; reconciliation absorbs it.
const TRASH_METADATA_SLACK = 64;

const submit = (slug: string) => request(app).post(`/api/public/${slug}/submit`);

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Form, ResponseModel, Upload, User, Workspace, Membership, Notification].map((m: any) => m.init()));
});

beforeEach(async () => {
  await clearRateLimitStore();
  await Promise.all([Form, ResponseModel, Upload, Membership, Workspace, User, Notification].map((m: any) => m.deleteMany({})));
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  process.env.RATE_LIMIT_MAX = "0";
  owner = await User.create({ firebaseUid: "uid-own", fullName: "Owner", email: "own@quota.test", role: "admin", status: "active" });
  member = await User.create({ firebaseUid: "uid-mem", fullName: "Member", email: "mem@quota.test", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "Quota", slug: "quota-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  await Membership.create({ userId: member._id, workspaceId: ws._id, role: "editor" });
});

afterEach(() => {
  delete process.env.RATE_LIMIT_MAX;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

describe("the running counter", () => {
  it("counts a form, a response and an upload against the workspace OWNER", async () => {
    const form: any = await mkForm();
    expect(await used()).toBe(bsonSize(await Form.findById(form._id).lean()));
    const before = await used();

    const response: any = await ResponseModel.create({ formId: form._id, answers: { Name: "x".repeat(1000) } });
    expect(await used()).toBe(before + bsonSize(await ResponseModel.findById(response._id).lean()));

    const mid = await used();
    await Upload.create({ name: "a.pdf", size: 5000, type: "application/pdf", path: "a.pdf", owner: owner._id });
    expect(await used()).toBe(mid + 5000);
    expect(await used(member)).toBe(0);
  });

  it("charges a member's builder upload to the workspace owner, not to the member", async () => {
    const form: any = await mkForm({ status: "draft" });
    await setUsed(0);
    const res = await request(app)
      .post("/api/upload")
      .set("Authorization", `Bearer ${tokenOf(member)}`)
      .set("x-workspace-id", ws._id.toString())
      .field("formId", form._id.toString())
      .field("type", "branding")
      .attach("logo", Buffer.alloc(3000, "x"), { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(await used()).toBe(3000);
    expect(await used(member)).toBe(0);
  });

  it("tracks form autosave as a size delta", async () => {
    const form: any = await mkForm();
    const before = await used();
    const sizeBefore = bsonSize(await Form.findById(form._id).lean());
    await Form.findOneAndUpdate({ _id: form._id }, { $set: { description: "d".repeat(2000) } }, { returnDocument: "after" });
    const sizeAfter = bsonSize(await Form.findById(form._id).lean());
    expect(sizeAfter - sizeBefore).toBe(2000);
    expect(await used()).toBe(before + sizeAfter - sizeBefore);
  });
});

describe("Trash", () => {
  it("moving to Trash changes nothing; purging and emptying release the bytes", async () => {
    const form: any = await mkForm();
    await ResponseModel.create({ formId: form._id, answers: { Name: "x".repeat(500) } });
    await Upload.create({
      name: "a.pdf",
      size: 4000,
      type: "application/pdf",
      owner: owner._id,
      path: path.join(owner._id.toString(), form._id.toString(), "responses", new mongoose.Types.ObjectId().toString(), "a.pdf"),
    });
    const full = await used();
    expect(full).toBeGreaterThan(4000);

    await Form.updateOne({ _id: form._id }, { $set: { deletedAt: new Date(), deletedBy: owner._id } });
    expect(await used()).toBe(full);

    await purgeItem(scope(), "form", form._id.toString());
    expect(Math.abs(await used())).toBeLessThan(TRASH_METADATA_SLACK);

    const second: any = await mkForm();
    await Form.updateOne({ _id: second._id }, { $set: { deletedAt: new Date() } });
    expect(await used()).toBeGreaterThan(0);
    await emptyTrash(scope());
    expect(Math.abs(await used())).toBeLessThan(TRASH_METADATA_SLACK);
  });

  it("a response trashed on its own still counts until it is purged", async () => {
    const form: any = await mkForm();
    const response: any = await ResponseModel.create({ formId: form._id, answers: { Name: "y" } });
    const formOnly = bsonSize(await Form.findById(form._id).lean());
    const before = await used();
    await ResponseModel.updateOne({ _id: response._id }, { $set: { deletedAt: new Date() } });
    expect(await used()).toBe(before);
    await purgeItem(scope(), "response", response._id.toString());
    expect(Math.abs((await used()) - formOnly)).toBeLessThan(TRASH_METADATA_SLACK);
  });
});

describe("enforcement", () => {
  it("public text answers survive the base quota, files do not, and past the ceiling the form is unavailable", async () => {
    const form: any = await mkForm();
    const quota = 500 * MB;

    const ok = await submit(form.publishedSlug).field("data", JSON.stringify({ Name: "A" })).attach("CV", Buffer.alloc(100, "x"), "cv.pdf");
    expect(ok.status).toBe(200);

    // Over the base quota, under the ceiling: text still goes through and the required file field is waived ...
    await setUsed(quota + 1);
    const pub = await request(app).get(`/api/public/${form.publishedSlug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.fields.find((f: any) => f.label === "CV")).toMatchObject({ uploadsDisabled: true, required: false });
    const textOnly = await submit(form.publishedSlug).field("data", JSON.stringify({ Name: "B" }));
    expect(textOnly.status).toBe(200);
    // ... and a file attached to the same submission is dropped, not stored.
    const uploadsBefore = await Upload.countDocuments({});
    const withFile = await submit(form.publishedSlug).field("data", JSON.stringify({ Name: "C" })).attach("CV", Buffer.alloc(100, "x"), "cv.pdf");
    expect(withFile.status).toBe(200);
    expect(await Upload.countDocuments({})).toBe(uploadsBefore);
    expect(await ResponseModel.countDocuments({ "answers.Name": "C" })).toBe(1);

    // Past the ceiling the whole form looks unavailable: the same 404 a closed form gives.
    await setUsed(Math.round(quota * 1.2) + 1);
    expect((await request(app).get(`/api/public/${form.publishedSlug}`)).status).toBe(404);
    const blocked = await submit(form.publishedSlug).field("data", JSON.stringify({ Name: "D" }));
    expect(blocked.status).toBe(404);
    expect(await ResponseModel.countDocuments({ "answers.Name": "D" })).toBe(0);
  });

  it("blocks new forms, workspaces and builder uploads past the base quota", async () => {
    await setUsed(500 * MB + 1);
    const token = tokenOf(owner);
    const f = await request(app).post("/api/forms").set("Authorization", `Bearer ${token}`).set("x-workspace-id", ws._id.toString()).send({ title: "New", fields: [] });
    expect(f.status).toBe(403);
    expect(f.body.error.code).toBe("STORAGE_QUOTA_EXCEEDED");

    const w = await request(app).post("/api/workspaces").set("Authorization", `Bearer ${token}`).send({ name: "Another" });
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe("STORAGE_QUOTA_EXCEEDED");

    const u = await request(app)
      .post("/api/upload")
      .set("Authorization", `Bearer ${token}`)
      .set("x-workspace-id", ws._id.toString())
      .field("type", "branding")
      .attach("logo", Buffer.alloc(10, "x"), { filename: "l.png", contentType: "image/png" });
    expect(u.status).toBe(403);
    expect(u.body.error.code).toBe("STORAGE_QUOTA_EXCEEDED");
  });

  it("caps how many workspaces a user may own, and leaves existing ones alone", async () => {
    await User.updateOne({ _id: owner._id }, { $set: { workspaceLimit: 1 } });
    const res = await request(app).post("/api/workspaces").set("Authorization", `Bearer ${tokenOf(owner)}`).send({ name: "Second" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("WORKSPACE_LIMIT_REACHED");
    expect(await Workspace.countDocuments({ owner: owner._id })).toBe(1);
  });

  it("warns once when 80% is crossed", async () => {
    await setUsed(400 * MB - 10);
    await Upload.create({ name: "a", size: 20, type: "x", path: "a", owner: owner._id });
    await Upload.create({ name: "b", size: 20, type: "x", path: "b", owner: owner._id });
    expect(await Notification.countDocuments({ userId: owner._id, type: "storage_warning" })).toBe(1);
  });

  it("GET /api/users/me reports the numbers the sidebar needs", async () => {
    const form: any = await mkForm();
    await Form.updateOne({ _id: form._id }, { $set: { deletedAt: new Date() } });
    const res = await request(app).get("/api/users/me").set("Authorization", `Bearer ${tokenOf(owner)}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ storageQuotaBytes: 500 * MB, workspaceCount: 1, workspaceLimit: 10 });
    expect(res.body.user.storageUsedBytes).toBeGreaterThan(0);
    expect(res.body.user.storageTrashBytes).toBeGreaterThan(0);
    expect(res.body.user.storageTrashBytes).toBeLessThanOrEqual(res.body.user.storageUsedBytes);
  });
});

describe("reconciliation", () => {
  it("detects and fixes a corrupted counter, Trash included", async () => {
    const form: any = await mkForm();
    await ResponseModel.create({ formId: form._id, answers: { Name: "z".repeat(300) } });
    await Upload.create({ name: "a", size: 777, type: "x", path: "a", owner: owner._id });
    await Form.updateOne({ _id: form._id }, { $set: { deletedAt: new Date() } });
    const truth = await computeTrueUsage(owner._id);

    await setUsed(truth + 123456);
    const dry = await reconcileUser(owner._id, { dryRun: true });
    expect(dry.drift).toBe(123456);
    expect(await used()).toBe(truth + 123456);

    const fixed = await reconcileUser(owner._id);
    expect(fixed.fixed).toBe(true);
    expect(await used()).toBe(truth);
  });

  it("the scheduled run fixes every user and skips one whose counter moves while it is measured", async () => {
    await mkForm();
    await setUsed(999999, owner);
    await setUsed(123, member);
    const results = await reconcileAllStorage();
    expect(results.filter((r) => r.fixed).length).toBe(2);
    expect(await used(owner)).toBe(await computeTrueUsage(owner._id));
    expect(await used(member)).toBe(0);

    // A write landing during the measurement must not be overwritten by the stale total.
    const realAggregate = Upload.aggregate.bind(Upload);
    jest.spyOn(Upload, "aggregate").mockImplementationOnce(((...args: any[]) =>
      User.updateOne({ _id: owner._id }, { $inc: { storageUsedBytes: 50 } }).then(() => (realAggregate as any)(...args))) as any);
    const before = await used(owner);
    const skipped = await reconcileUser(owner._id);
    jest.restoreAllMocks();
    expect(skipped.skipped).toBe(true);
    expect(skipped.fixed).toBe(false);
    expect(await used(owner)).toBe(before + 50); // left alone for the next run
  });

  it("the admin endpoints list over-quota accounts, change limits with an audit row, and reconcile", async () => {
    const admin = await User.create({ firebaseUid: "uid-sa", fullName: "SA", email: "sa@quota.test", role: "super_admin", status: "active" });
    const sa = tokenOf(admin);
    await setUsed(600 * MB);

    const list = await request(app).get("/api/superadmin/storage/over-quota").set("Authorization", `Bearer ${sa}`);
    expect(list.status).toBe(200);
    expect(list.body.accounts[0]).toMatchObject({ id: owner._id.toString(), overBy: 100 * MB });

    const patch = await request(app)
      .patch(`/api/superadmin/admins/${owner._id}/limits`)
      .set("Authorization", `Bearer ${sa}`)
      .send({ storageQuotaBytes: 1000 * MB, workspaceLimit: 3 });
    expect(patch.status).toBe(200);
    expect(await User.findById(owner._id).lean()).toMatchObject({ storageQuotaBytes: 1000 * MB, workspaceLimit: 3 });
    expect(await AuditLog.countDocuments({ action: "admin.limits", targetId: owner._id.toString() })).toBe(1);

    const rec = await request(app).post("/api/superadmin/storage/reconcile").set("Authorization", `Bearer ${sa}`).send({ userId: owner._id.toString() });
    expect(rec.status).toBe(200);
    expect(rec.body.results[0].userId).toBe(owner._id.toString());
    expect(await used()).toBe(await computeTrueUsage(owner._id));
  });
});
