// Delete cascades, account deletion guards, ownership transfer and leaving a workspace.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { getAuth } from "firebase-admin/auth";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Invitation from "../models/Invitation";
import FormAccessGrant from "../models/FormAccessGrant";
import Upload from "../models/Upload";
import Report from "../models/Report";
import Notification from "../models/Notification";
import SessionModel from "../models/Session";
import { Event } from "../models/Event";
import { generateToken } from "../utils/generateToken";

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "beginso-del-"));
process.env.UPLOAD_DIR = uploadDir;
process.env.JWT_SECRET = "test-jwt-secret-key-for-deletion-ownership-suite";

let mongoServer: MongoMemoryServer;
let owner: any;
let admin: any;
let member: any;
let other: any; // owner of an unrelated workspace
let wsMain: any;
let wsOther: any;

const tok = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role });
const as = (r: request.Test, u: any) => r.set("Authorization", `Bearer ${tok(u)}`);
const reauth = (u: any) => ({ reauthToken: `reauth-${u.firebaseUid}` });
const mkUser = (key: string) => User.create({ firebaseUid: `uid-del-${key}`, fullName: key, email: `${key}@del.test`, role: "admin", status: "active" });
const mkForm = (workspaceId: any, createdBy: any) =>
  Form.create({ title: `f-${crypto.randomBytes(3).toString("hex")}`, workspaceId, createdBy, fields: [{ fieldId: "f1", label: "File", type: "file_upload", required: false }] });

// A response attachment as the app stores it: <ownerId>/<formId>/responses/<responseId>/<name>
const mkResponseWithFile = async (form: any, ownerId: any) => {
  const resp = await ResponseModel.create({ formId: form._id, answers: {} });
  const rel = path.join(ownerId.toString(), form._id.toString(), "responses", resp._id.toString(), "cv.pdf");
  fs.mkdirSync(path.dirname(path.join(uploadDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, rel), "PDF");
  fs.writeFileSync(path.join(path.dirname(path.join(uploadDir, rel)), "response.json"), "{}");
  const up = await Upload.create({ name: "cv.pdf", size: 3, type: "application/pdf", path: rel, owner: ownerId, isBranding: false });
  return { resp, up, abs: path.join(uploadDir, rel), dir: path.dirname(path.join(uploadDir, rel)) };
};

const resetData = async () => {
  await Promise.all([Form, ResponseModel, Invitation, FormAccessGrant, Upload, Report, Notification, SessionModel, Membership].map((m: any) => m.deleteMany({})));
  await Event.collection.deleteMany({}); // the model blocks deletes (append-only audit log)
  await Workspace.deleteMany({});
  await User.deleteMany({});
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });

  owner = await mkUser("owner");
  admin = await mkUser("admin");
  member = await mkUser("member");
  other = await mkUser("other");
  wsMain = await Workspace.create({ name: "Main", slug: "main-del", timezone: "UTC", owner: owner._id });
  wsOther = await Workspace.create({ name: "Other", slug: "other-del", timezone: "UTC", owner: other._id });
  await User.updateOne({ _id: owner._id }, { $set: { workspaceId: wsMain._id } });
  await User.updateOne({ _id: other._id }, { $set: { workspaceId: wsOther._id } });
  await Membership.create([
    { userId: owner._id, workspaceId: wsMain._id, role: "owner" },
    { userId: admin._id, workspaceId: wsMain._id, role: "admin" },
    { userId: member._id, workspaceId: wsMain._id, role: "editor" },
    { userId: other._id, workspaceId: wsOther._id, role: "owner" },
  ]);
};

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User, Workspace, Membership, Form, ResponseModel, Invitation, FormAccessGrant, Upload, Report, Notification, SessionModel, Event].map((m: any) => m.init()));
});

beforeEach(resetData);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

describe("deleting a form or a response leaves no files or rows behind", () => {
  it("form: responses, grants, upload rows, files and the whole form folder", async () => {
    const form = await mkForm(wsMain._id, owner._id);
    const { resp, up, abs, dir } = await mkResponseWithFile(form, owner._id);
    await FormAccessGrant.create({ formId: form._id, userId: member._id, role: "viewer", grantedBy: owner._id });

    // Sprint 13: DELETE now moves the form to Trash - nothing is destroyed yet...
    const res = await as(request(app).delete(`/api/forms/${form._id}`), owner);
    expect(res.status).toBe(200);
    expect(await ResponseModel.findById(resp._id)).not.toBeNull();
    expect(await Upload.findById(up._id)).not.toBeNull();
    expect(fs.existsSync(abs)).toBe(true);
    // ...and a permanent delete from Trash leaves no files or rows behind.
    const purge = await as(request(app).delete(`/api/trash/form/${form._id}`).send({ confirm: "DELETE" }), owner);
    expect(purge.status).toBe(200);
    expect(await ResponseModel.findById(resp._id)).toBeNull();
    expect(await Upload.findById(up._id)).toBeNull();
    expect(await FormAccessGrant.countDocuments({ formId: form._id })).toBe(0);
    expect(fs.existsSync(abs)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(uploadDir, owner._id.toString(), form._id.toString()))).toBe(false);
  });

  it("response: its files, its folder (including response.json) and its upload rows", async () => {
    const form = await mkForm(wsMain._id, owner._id);
    const keep = await mkResponseWithFile(form, owner._id);
    const gone = await mkResponseWithFile(form, owner._id);

    const res = await as(request(app).delete(`/api/responses/${gone.resp._id}`), owner);
    expect(res.status).toBe(204);
    // Sprint 13: the response is in Trash, files kept - until it is deleted permanently.
    expect(await Upload.findById(gone.up._id)).not.toBeNull();
    const purge = await as(request(app).delete(`/api/trash/response/${gone.resp._id}`).send({ confirm: "DELETE" }), owner);
    expect(purge.status).toBe(200);
    expect(await Upload.findById(gone.up._id)).toBeNull();
    expect(fs.existsSync(gone.dir)).toBe(false);
    // a sibling response is untouched
    expect(await Upload.findById(keep.up._id)).not.toBeNull();
    expect(fs.existsSync(keep.abs)).toBe(true);
  });
});

describe("DELETE /api/workspaces/:id", () => {
  it("removes everything the workspace owns, keeps the owner's account and other workspaces, and keeps the audit event", async () => {
    const form = await mkForm(wsMain._id, owner._id);
    const files = await mkResponseWithFile(form, owner._id);
    await FormAccessGrant.create({ formId: form._id, userId: other._id, role: "viewer", grantedBy: owner._id });
    await Invitation.create({ workspaceId: wsMain._id, email: "pending@del.test", role: "viewer", status: "pending", token: "tok-del-1", expiresAt: new Date(Date.now() + 86400000), invitedBy: owner._id });
    await Report.create({ workspaceId: wsMain._id, format: "csv", status: "completed", expiresAt: new Date(Date.now() + 86400000) });
    await Notification.create({ userId: owner._id, workspaceId: wsMain._id, type: "welcome", title: "t", message: "m" });
    const otherForm = await mkForm(wsOther._id, other._id);
    const otherFiles = await mkResponseWithFile(otherForm, other._id);

    const res = await as(request(app).delete(`/api/workspaces/${wsMain._id}`), owner);
    expect(res.status).toBe(200);

    expect(await Workspace.findById(wsMain._id)).toBeNull();
    expect(await Form.countDocuments({ workspaceId: wsMain._id })).toBe(0);
    expect(await ResponseModel.countDocuments({ formId: form._id })).toBe(0);
    expect(await Upload.findById(files.up._id)).toBeNull();
    expect(fs.existsSync(files.abs)).toBe(false);
    expect(await FormAccessGrant.countDocuments({ formId: form._id })).toBe(0);
    expect(await Invitation.countDocuments({ workspaceId: wsMain._id })).toBe(0);
    expect(await Report.countDocuments({ workspaceId: wsMain._id })).toBe(0);
    expect(await Notification.countDocuments({ workspaceId: wsMain._id })).toBe(0);
    expect(await Membership.countDocuments({ workspaceId: wsMain._id })).toBe(0);

    // nobody's default workspace points at the deleted one
    expect((await User.findById(owner._id))?.workspaceId ?? null).toBeNull();
    // the account itself and unrelated tenants are untouched
    expect(await User.findById(owner._id)).not.toBeNull();
    expect(await Form.findById(otherForm._id)).not.toBeNull();
    expect(fs.existsSync(otherFiles.abs)).toBe(true);
    // the audit trail survives
    expect(await Event.countDocuments({ workspaceId: wsMain._id, action: "workspace.delete" })).toBe(1);
  });

  it("is owner-only", async () => {
    const res = await as(request(app).delete(`/api/workspaces/${wsMain._id}`), admin);
    expect(res.status).toBe(403);
    expect(await Workspace.findById(wsMain._id)).not.toBeNull();
  });
});

describe("account deletion (DELETE /api/users/profile and DELETE /api/workspaces/current)", () => {
  it.each([
    ["DELETE /api/users/profile", "/api/users/profile"],
    ["DELETE /api/workspaces/current", "/api/workspaces/current"],
  ])("%s needs a fresh password confirmation", async (_label, url) => {
    const solo = await mkUser("solo");
    const ws = await Workspace.create({ name: "Solo", slug: `solo-${url.length}`, timezone: "UTC", owner: solo._id });
    await Membership.create({ userId: solo._id, workspaceId: ws._id, role: "owner" });
    await User.updateOne({ _id: solo._id }, { $set: { workspaceId: ws._id } });

    const none = await as(request(app).delete(url), solo);
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe("REAUTH_REQUIRED");

    const wrongUser = await as(request(app).delete(url).send(reauth(other)), solo);
    expect(wrongUser.status).toBe(401);
    expect(wrongUser.body.error.code).toBe("REAUTH_MISMATCH");

    expect(await User.findById(solo._id)).not.toBeNull();
    expect(await Workspace.findById(ws._id)).not.toBeNull();
  });

  it("a stale confirmation is rejected", async () => {
    const solo = await mkUser("stale");
    jest.spyOn(getAuth(), "verifyIdToken").mockResolvedValue({ uid: solo.firebaseUid, auth_time: Math.floor(Date.now() / 1000) - 3600 } as any);
    const res = await as(request(app).delete("/api/users/profile").send({ reauthToken: "any" }), solo);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("REAUTH_EXPIRED");
    expect(await User.findById(solo._id)).not.toBeNull();
  });

  it("refuses while the account owns a workspace other people belong to, and deletes nothing", async () => {
    const form = await mkForm(wsMain._id, owner._id);
    const res = await as(request(app).delete("/api/workspaces/current").set("x-workspace-id", wsMain._id.toString()).send(reauth(owner)), owner);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("OWNS_SHARED_WORKSPACES");
    expect(res.body.workspaces[0]).toMatchObject({ id: wsMain._id.toString(), otherMembers: 2 });
    expect(await User.findById(owner._id)).not.toBeNull();
    expect(await Form.findById(form._id)).not.toBeNull();
    expect(await Membership.countDocuments({ workspaceId: wsMain._id })).toBe(3);
  });

  it("closes a solo owner's account completely and leaves other people's workspaces alone", async () => {
    const solo = await mkUser("closer");
    const ws = await Workspace.create({ name: "Solo", slug: "solo-closer", timezone: "UTC", owner: solo._id });
    await Membership.create([
      { userId: solo._id, workspaceId: ws._id, role: "owner" },
      { userId: solo._id, workspaceId: wsOther._id, role: "viewer" }, // member of someone else's workspace
    ]);
    await User.updateOne({ _id: solo._id }, { $set: { workspaceId: ws._id } });

    const wsForm = await mkForm(ws._id, solo._id);
    const wsFiles = await mkResponseWithFile(wsForm, solo._id);
    const personal = await mkForm(null, solo._id);
    const personalFiles = await mkResponseWithFile(personal, solo._id);
    await SessionModel.create({ userId: solo._id, deviceLabel: "d", userAgent: "u", ipHash: "abcdabcdabcdabcd", lastActiveAt: new Date() });
    await Notification.create({ userId: solo._id, workspaceId: ws._id, type: "welcome", title: "t", message: "m" });
    const othersForm = await mkForm(wsOther._id, other._id);

    const res = await as(request(app).delete("/api/users/profile").send(reauth(solo)), solo);
    expect(res.status).toBe(200);

    expect(await User.findById(solo._id)).toBeNull();
    expect(await Workspace.findById(ws._id)).toBeNull();
    expect(await Form.findById(wsForm._id)).toBeNull();
    expect(await Form.findById(personal._id)).toBeNull();
    expect(await Upload.findById(wsFiles.up._id)).toBeNull();
    expect(await Upload.findById(personalFiles.up._id)).toBeNull();
    expect(fs.existsSync(wsFiles.abs)).toBe(false);
    expect(fs.existsSync(personalFiles.abs)).toBe(false);
    expect(fs.existsSync(path.join(uploadDir, solo._id.toString()))).toBe(false);
    expect(await Membership.countDocuments({ userId: solo._id })).toBe(0);
    expect(await SessionModel.countDocuments({ userId: solo._id })).toBe(0);
    expect(await Notification.countDocuments({ userId: solo._id })).toBe(0);

    // the workspace they were only a member of is intact
    expect(await Workspace.findById(wsOther._id)).not.toBeNull();
    expect(await Form.findById(othersForm._id)).not.toBeNull();
    expect(await Membership.findOne({ workspaceId: wsOther._id, userId: other._id })).not.toBeNull();
  });

  it("if Firebase cannot delete the login, the account is left untouched so the user can retry", async () => {
    const solo = await mkUser("fbfail");
    jest.spyOn(getAuth(), "deleteUser").mockRejectedValue(Object.assign(new Error("boom"), { code: "auth/internal-error" }));
    jest.spyOn(console, "error").mockImplementation(() => {}); // the handler logs the failure it reports
    const res = await as(request(app).delete("/api/users/profile").send(reauth(solo)), solo);
    expect(res.status).toBe(502);
    expect(await User.findById(solo._id)).not.toBeNull();
  });

  it("an admin (not the owner) cannot close the account through the workspace route", async () => {
    const res = await as(request(app).delete("/api/workspaces/current").set("x-workspace-id", wsMain._id.toString()).send(reauth(admin)), admin);
    expect(res.status).toBe(403);
    expect(await User.findById(admin._id)).not.toBeNull();
  });
});

describe("transferring ownership", () => {
  const transfer = (actor: any, to: any, ws: any = wsMain) =>
    as(request(app).post(`/api/workspaces/${ws._id}/transfer-ownership`).send({ userId: to._id.toString() }), actor);

  it("makes the member the owner, demotes the old owner to admin, and records an event", async () => {
    const res = await transfer(owner, member);
    expect(res.status).toBe(200);

    expect((await Workspace.findById(wsMain._id))?.owner.toString()).toBe(member._id.toString());
    expect((await Membership.findOne({ workspaceId: wsMain._id, userId: member._id }))?.role).toBe("owner");
    expect((await Membership.findOne({ workspaceId: wsMain._id, userId: owner._id }))?.role).toBe("admin");
    const [ev] = await Event.find({ workspaceId: wsMain._id, action: "workspace.transfer_ownership" }).lean();
    expect(ev.metadata?.to).toBe(member._id.toString());

    // the new owner can delete the workspace, the old owner (now admin) cannot
    expect((await as(request(app).delete(`/api/workspaces/${wsMain._id}`), owner)).status).toBe(403);
    expect((await as(request(app).delete(`/api/workspaces/${wsMain._id}`), member)).status).toBe(200);
  });

  it("only the owner can transfer, and only to an existing member", async () => {
    expect((await transfer(admin, member)).status).toBe(403);
    expect((await transfer(owner, other)).status).toBe(404); // not a member of this workspace
    expect((await transfer(owner, owner)).status).toBe(400); // already the owner
    expect((await Workspace.findById(wsMain._id))?.owner.toString()).toBe(owner._id.toString());
  });
});

describe("leaving a workspace", () => {
  const leave = (actor: any, ws: any = wsMain) => as(request(app).post(`/api/workspaces/${ws._id}/leave`), actor);

  it("a member leaves, loses access, and no default workspace still points at it", async () => {
    await User.updateOne({ _id: member._id }, { $set: { workspaceId: wsMain._id } });
    const res = await leave(member);
    expect(res.status).toBe(200);
    expect(await Membership.findOne({ workspaceId: wsMain._id, userId: member._id })).toBeNull();
    expect((await User.findById(member._id))?.workspaceId ?? null).toBeNull();
    expect((await as(request(app).get(`/api/workspaces/${wsMain._id}`), member)).status).toBe(403);
    expect(await Event.countDocuments({ workspaceId: wsMain._id, action: "member.leave" })).toBe(1);
  });

  it("the only owner cannot leave until ownership is transferred", async () => {
    const blocked = await leave(owner);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe("LAST_OWNER");
    expect(await Membership.findOne({ workspaceId: wsMain._id, userId: owner._id })).not.toBeNull();

    await as(request(app).post(`/api/workspaces/${wsMain._id}/transfer-ownership`).send({ userId: admin._id.toString() }), owner);
    expect((await leave(owner)).status).toBe(200);
    expect(await Membership.findOne({ workspaceId: wsMain._id, userId: owner._id })).toBeNull();
    expect(await Workspace.findById(wsMain._id)).not.toBeNull();
  });

  it("someone who is not a member cannot 'leave'", async () => {
    expect((await leave(other)).status).toBe(403);
  });
});
