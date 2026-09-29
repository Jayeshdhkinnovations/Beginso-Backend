import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Note from "../models/Note";
import Notification from "../models/Notification";
import FormAccessGrant from "../models/FormAccessGrant";
import { generateToken } from "../utils/generateToken";
import { generateReportAsync } from "../services/report.service";
import ReportModel from "../models/Report";
import fs from "fs";

let mongoServer: MongoMemoryServer;

let ownerToken: string;
let adminToken: string;
let memberToken: string;
let outsiderToken: string;
let ownerId: string;
let adminId: string;
let memberId: string;
let outsiderId: string;
let workspaceId: string;
let formId: string;

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const owner = await User.create({ firebaseUid: "note-owner-uid", fullName: "Owner", email: "note-owner@test.com", role: "admin" });
  const admin = await User.create({ firebaseUid: "note-admin-uid", fullName: "Admin", email: "note-admin@test.com", role: "admin" });
  const member = await User.create({ firebaseUid: "note-member-uid", fullName: "Member", email: "note-member@test.com", role: "admin" });
  const outsider = await User.create({ firebaseUid: "note-outsider-uid", fullName: "Outsider", email: "note-outsider@test.com", role: "admin" });
  ownerId = owner._id.toString();
  adminId = admin._id.toString();
  memberId = member._id.toString();
  outsiderId = outsider._id.toString();

  const ws = await Workspace.create({ name: "Note Workspace", owner: owner._id });
  workspaceId = (ws._id as mongoose.Types.ObjectId).toString();
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  await Membership.create({ userId: admin._id, workspaceId: ws._id, role: "admin" });
  await Membership.create({ userId: member._id, workspaceId: ws._id, role: "member" });

  const form = await Form.create({
    title: "Note Form",
    workspaceId: ws._id,
    status: "published",
    publishedSlug: "note-form-slug",
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
  });
  formId = (form._id as mongoose.Types.ObjectId).toString();

  ownerToken = generateToken({ id: ownerId, email: owner.email, role: owner.role });
  adminToken = generateToken({ id: adminId, email: admin.email, role: admin.role });
  memberToken = generateToken({ id: memberId, email: member.email, role: member.role });
  outsiderToken = generateToken({ id: outsiderId, email: outsider.email, role: outsider.role });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe("Note CRUD (B5.1)", () => {
  it("creates a note and returns it in the list", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    const createRes = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "Looks good to me" });
    expect(createRes.status).toBe(201);
    expect(createRes.body.note.body).toBe("Looks good to me");
    expect(createRes.body.note.authorId).toBe(ownerId);
    expect(createRes.body.note.editedAt).toBeNull();

    const listRes = await request(app)
      .get(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.notes.length).toBe(1);
  });

  it("rejects an empty or over-length body with 422", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    const empty = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "" });
    expect(empty.status).toBe(422);

    const tooLong = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "x".repeat(5001) });
    expect(tooLong.status).toBe(422);
  });

  it("author-only edit: a non-author gets 403, the author succeeds", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    const createRes = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ body: "original" });
    const noteId = createRes.body.note.id;

    const forbidden = await request(app)
      .patch(`/api/responses/${resp._id}/notes/${noteId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "hijacked" });
    expect(forbidden.status).toBe(403);

    const ok = await request(app)
      .patch(`/api/responses/${resp._id}/notes/${noteId}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ body: "edited by author" });
    expect(ok.status).toBe(200);
    expect(ok.body.note.body).toBe("edited by author");
    expect(ok.body.note.editedAt).not.toBeNull();
  });

  it("delete: author or Admin+ only, a plain member (non-author) is forbidden", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    const createRes = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ body: "to be judged" });
    const noteId = createRes.body.note.id;

    // A second, non-author, non-admin member cannot delete it.
    const otherMember = await User.create({ firebaseUid: "note-member2-uid", fullName: "Member Two", email: "note-member2@test.com", role: "admin" });
    await Membership.create({ userId: otherMember._id, workspaceId, role: "member" });
    const otherMemberToken = generateToken({ id: otherMember._id.toString(), email: otherMember.email, role: otherMember.role });

    const forbidden = await request(app)
      .delete(`/api/responses/${resp._id}/notes/${noteId}`)
      .set("Authorization", `Bearer ${otherMemberToken}`);
    expect(forbidden.status).toBe(403);

    // The author can delete their own note.
    const byAuthor = await request(app)
      .delete(`/api/responses/${resp._id}/notes/${noteId}`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(byAuthor.status).toBe(204);
    expect(await Note.exists({ _id: noteId })).toBeNull();
  });

  it("delete: an Admin may delete someone else's note", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    const createRes = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ body: "admin will remove this" });
    const noteId = createRes.body.note.id;

    const byAdmin = await request(app)
      .delete(`/api/responses/${resp._id}/notes/${noteId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(byAdmin.status).toBe(204);
  });
});

describe("Mentions (B5.2)", () => {
  it("422s a mention with no access, with an identical message whether the id doesn't exist or the user exists but lacks access", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });

    const nonExistent = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "hi", mentionIds: [new mongoose.Types.ObjectId().toString()] });
    expect(nonExistent.status).toBe(422);

    const noAccess = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "hi", mentionIds: [outsiderId] });
    expect(noAccess.status).toBe(422);

    // Same shape: same status, same error code, same message — outside observers cannot tell
    // "doesn't exist" apart from "exists but no access".
    expect(nonExistent.body.error.code).toBe(noAccess.body.error.code);
    expect(nonExistent.body.error.message).toBe(noAccess.body.error.message);
    expect(nonExistent.body.message).toBe(noAccess.body.message);
  });

  it("mentioning a current member with access succeeds and notifies them (not the author)", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    const res = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "cc @member", mentionIds: [memberId, ownerId] });
    expect(res.status).toBe(201);
    expect(res.body.note.mentions.map((m: any) => m.id).sort()).toEqual([memberId, ownerId].sort());

    const memberNotif = await Notification.findOne({ userId: memberId, type: "mention" });
    expect(memberNotif).not.toBeNull();
    // The author mentioning themselves writes no notification.
    const ownerNotif = await Notification.findOne({ userId: ownerId, type: "mention" });
    expect(ownerNotif).toBeNull();
  });

  it("a per-form grant (no workspace membership) counts as access for mentions", async () => {
    const grantee = await User.create({ firebaseUid: "note-grantee-uid", fullName: "Grantee", email: "note-grantee@test.com", role: "admin" });
    await FormAccessGrant.create({ formId, userId: grantee._id, role: "reviewer" });

    const resp = await ResponseModel.create({ formId, answers: {} });
    const res = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "cc grantee", mentionIds: [grantee._id.toString()] });
    expect(res.status).toBe(201);
  });

  it("on edit, only NEWLY added mentions are notified (not ones already present, not the author)", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    const createRes = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "v1", mentionIds: [memberId] });
    const noteId = createRes.body.note.id;
    await Notification.deleteMany({}); // isolate the edit's own notifications

    await request(app)
      .patch(`/api/responses/${resp._id}/notes/${noteId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ mentionIds: [memberId, adminId] });

    // memberId was already mentioned before this edit: no new notification for them.
    expect(await Notification.countDocuments({ userId: memberId, type: "mention" })).toBe(0);
    // adminId is newly mentioned: exactly one notification.
    expect(await Notification.countDocuments({ userId: adminId, type: "mention" })).toBe(1);
  });
});

describe("noteCount (B5.x)", () => {
  it("is a live count reflected on both list and detail, including after delete", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });

    const detail0 = await request(app).get(`/api/responses/${resp._id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(detail0.body.response.noteCount).toBe(0);

    const n1 = await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "one" });
    await request(app)
      .post(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ body: "two" });

    const detail1 = await request(app).get(`/api/responses/${resp._id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(detail1.body.response.noteCount).toBe(2);

    const list = await request(app).get(`/api/responses?formId=${formId}`).set("Authorization", `Bearer ${ownerToken}`);
    const listed = list.body.data.find((r: any) => r._id === resp._id.toString());
    expect(listed.noteCount).toBe(2);

    await request(app)
      .delete(`/api/responses/${resp._id}/notes/${n1.body.note.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const detail2 = await request(app).get(`/api/responses/${resp._id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(detail2.body.response.noteCount).toBe(1);
  });
});

describe("Notes are never reachable from a respondent-facing, public or export path", () => {
  it("getPublicFormBySlug never includes note data", async () => {
    const res = await request(app).get(`/api/public/note-form-slug`);
    expect(res.status).toBe(200);
    const asString = JSON.stringify(res.body);
    expect(asString.toLowerCase()).not.toContain("notecount");
    expect(asString.toLowerCase()).not.toContain('"notes"');
  });

  it("submitPublicForm's response never includes note data", async () => {
    const res = await request(app).post(`/api/public/note-form-slug/submit`).send({ Name: "Anon" });
    expect(res.status).toBe(200);
    const asString = JSON.stringify(res.body);
    expect(asString.toLowerCase()).not.toContain("notecount");
    expect(asString.toLowerCase()).not.toContain('"notes"');
  });

  it("the authenticated getSubmissions (form-owner) path never includes note data", async () => {
    await ResponseModel.create({ formId, answers: {} });
    const res = await request(app)
      .get(`/api/forms/${formId}/submissions`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const asString = JSON.stringify(res.body);
    expect(asString.toLowerCase()).not.toContain("notecount");
  });

  it("the CSV export never includes a note or note count column, even when notes exist", async () => {
    const resp = await ResponseModel.create({ formId, answers: { Name: "HasNotes" }, reference: "#900" });
    await Note.create({ responseId: resp._id, authorId: ownerId, authorName: "Owner", body: "a private note", mentionIds: [] });

    const report = await ReportModel.create({
      workspaceId,
      requestedBy: ownerId,
      format: "csv",
      status: "queued",
      filters: { formId },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await generateReportAsync(report._id.toString());
    const refreshed = await ReportModel.findById(report._id);
    expect(refreshed!.status).toBe("completed");

    const csv = fs.readFileSync(refreshed!.filePath as string, "utf8");
    expect(csv.toLowerCase()).not.toContain("a private note");
    expect(csv.toLowerCase()).not.toContain("notecount");
  });

  it("Note documents are never populated onto a Response query result", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    await Note.create({ responseId: resp._id, authorId: ownerId, authorName: "Owner", body: "secret", mentionIds: [] });
    const raw = await ResponseModel.findById(resp._id).lean();
    expect(JSON.stringify(raw)).not.toContain("secret");
  });
});
