import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import ResponseReadState from "../models/ResponseReadState";
import Notification from "../models/Notification";
import { generateToken } from "../utils/generateToken";
import { MAX_BULK_BATCH_SIZE } from "../validations/bulk.validator";

let mongoServer: MongoMemoryServer;

let ownerToken: string;
let memberToken: string;
let outsiderToken: string; // no membership, no grant, anywhere relevant
let ownerId: string;
let memberId: string;
let outsiderId: string;
let workspaceId: string;
let formId: string;

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const owner = await User.create({ firebaseUid: "ro-owner-uid", fullName: "Owner", email: "ro-owner@test.com", role: "admin" });
  const member = await User.create({ firebaseUid: "ro-member-uid", fullName: "Member", email: "ro-member@test.com", role: "admin" });
  const outsider = await User.create({ firebaseUid: "ro-outsider-uid", fullName: "Outsider", email: "ro-outsider@test.com", role: "admin" });
  ownerId = owner._id.toString();
  memberId = member._id.toString();
  outsiderId = outsider._id.toString();

  const ws = await Workspace.create({ name: "RO Workspace", owner: owner._id });
  workspaceId = (ws._id as mongoose.Types.ObjectId).toString();
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  await Membership.create({ userId: member._id, workspaceId: ws._id, role: "member" });

  const form = await Form.create({
    title: "RO Form",
    workspaceId: ws._id,
    status: "published",
    publishedSlug: "ro-form-slug",
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
  });
  formId = (form._id as mongoose.Types.ObjectId).toString();

  ownerToken = generateToken({ id: ownerId, email: owner.email, role: owner.role });
  memberToken = generateToken({ id: memberId, email: member.email, role: member.role });
  outsiderToken = generateToken({ id: outsiderId, email: outsider.email, role: outsider.role });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe("Assignment (B3.2/R4)", () => {
  it("422s when assigneeId has no access to the response's form/workspace", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    const res = await request(app)
      .patch(`/api/responses/${resp._id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ assigneeId: outsiderId });
    expect(res.status).toBe(422);
  });

  it("assigns to a current member and writes a notification (not for self-assignment)", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    const res = await request(app)
      .patch(`/api/responses/${resp._id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ assigneeId: memberId });
    expect(res.status).toBe(200);
    expect(res.body.response.assigneeId).toBe(memberId);

    const notif = await Notification.findOne({ userId: memberId, type: "assignment" });
    expect(notif).not.toBeNull();
  });

  it("self-assignment writes no notification", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    await request(app)
      .patch(`/api/responses/${resp._id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ assigneeId: ownerId });

    const count = await Notification.countDocuments({ userId: ownerId, type: "assignment" });
    expect(count).toBe(0);
  });

  it("null unassigns", async () => {
    const resp = await ResponseModel.create({ formId, answers: {}, assigneeId: new mongoose.Types.ObjectId(memberId) });
    const res = await request(app)
      .patch(`/api/responses/${resp._id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ assigneeId: null });
    expect(res.status).toBe(200);
    expect(res.body.response.assigneeId).toBeNull();
  });
});

describe("Per-user unread state (B8.2)", () => {
  it("isolates read state between two different users", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });

    await request(app).post(`/api/responses/${resp._id}/read`).set("Authorization", `Bearer ${ownerToken}`);

    const ownerDetail = await request(app).get(`/api/responses/${resp._id}`).set("Authorization", `Bearer ${ownerToken}`);
    const memberDetail = await request(app).get(`/api/responses/${resp._id}`).set("Authorization", `Bearer ${memberToken}`);

    expect(ownerDetail.body.response.unread).toBe(false);
    expect(memberDetail.body.response.unread).toBe(true);
  });

  it("a GET never mutates read state", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });

    await request(app).get(`/api/responses/${resp._id}`).set("Authorization", `Bearer ${ownerToken}`);
    const row = await ResponseReadState.findOne({ userId: ownerId, responseId: resp._id });
    expect(row).toBeNull();

    // The list endpoint (also a GET) must not mutate either.
    await request(app).get(`/api/responses?formId=${formId}`).set("Authorization", `Bearer ${ownerToken}`);
    const rowAfterList = await ResponseReadState.findOne({ userId: ownerId, responseId: resp._id });
    expect(rowAfterList).toBeNull();
  });

  it("mark read then unread is idempotent both ways", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });

    const r1 = await request(app).post(`/api/responses/${resp._id}/read`).set("Authorization", `Bearer ${ownerToken}`);
    const r2 = await request(app).post(`/api/responses/${resp._id}/read`).set("Authorization", `Bearer ${ownerToken}`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await ResponseReadState.countDocuments({ userId: ownerId, responseId: resp._id })).toBe(1);

    const u1 = await request(app).post(`/api/responses/${resp._id}/unread`).set("Authorization", `Bearer ${ownerToken}`);
    const u2 = await request(app).post(`/api/responses/${resp._id}/unread`).set("Authorization", `Bearer ${ownerToken}`);
    expect(u1.status).toBe(200);
    expect(u2.status).toBe(200);
    expect(await ResponseReadState.countDocuments({ userId: ownerId, responseId: resp._id })).toBe(0);
  });
});

describe("Bulk endpoint (B2.1)", () => {
  it("rejects a request over the max batch size with 413, without touching anything", async () => {
    const ids = Array.from({ length: MAX_BULK_BATCH_SIZE + 1 }, () => new mongoose.Types.ObjectId().toString());
    const res = await request(app)
      .post(`/api/responses/bulk`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ target: { ids }, action: { type: "read" } });
    expect(res.status).toBe(413);
  });

  it("never marks a failed id as succeeded when the batch is a mix of allowed/forbidden ids", async () => {
    const allowed = await ResponseModel.create({ formId, answers: {} });

    // A response belonging to a totally different, unrelated workspace/form: the caller has
    // neither workspace membership nor a per-form grant on it.
    const otherOwner = await User.create({ firebaseUid: "ro-other-uid", fullName: "Other", email: "ro-other@test.com", role: "admin" });
    const otherWs = await Workspace.create({ name: "Other WS", owner: otherOwner._id });
    await Membership.create({ userId: otherOwner._id, workspaceId: otherWs._id, role: "owner" });
    const otherForm = await Form.create({
      title: "Other Form",
      workspaceId: otherWs._id,
      status: "published",
      publishedSlug: "other-form-slug",
      fields: [],
    });
    const forbidden = await ResponseModel.create({ formId: otherForm._id, answers: {} });

    const res = await request(app)
      .post(`/api/responses/bulk`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ target: { ids: [allowed._id.toString(), forbidden._id.toString()] }, action: { type: "read" } });

    expect(res.status).toBe(200);
    expect(res.body.succeeded).toEqual([allowed._id.toString()]);
    expect(res.body.failed.map((f: any) => f.id)).toEqual([forbidden._id.toString()]);
    expect(res.body.failed[0].reason).toBeTruthy();
  });

  it("bulk delete soft-deletes and bulk restore reverses it", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });

    const delRes = await request(app)
      .post(`/api/responses/bulk`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ target: { ids: [resp._id.toString()] }, action: { type: "delete" } });
    expect(delRes.status).toBe(200);
    expect(delRes.body.succeeded).toEqual([resp._id.toString()]);

    const afterDelete = await ResponseModel.findById(resp._id);
    expect(afterDelete!.deletedAt).not.toBeNull();

    const restoreRes = await request(app)
      .post(`/api/responses/bulk`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ target: { ids: [resp._id.toString()] }, action: { type: "restore" } });
    expect(restoreRes.status).toBe(200);

    const afterRestore = await ResponseModel.findById(resp._id);
    expect(afterRestore!.deletedAt).toBeNull();
  });
});

describe("Soft delete exclusion (B2.2 / OQ-3)", () => {
  it("excludes a soft-deleted response from the list and stats endpoints", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });

    await request(app)
      .post(`/api/responses/bulk`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ target: { ids: [resp._id.toString()] }, action: { type: "delete" } });

    const listRes = await request(app).get(`/api/responses?formId=${formId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.body.data.some((r: any) => r._id === resp._id.toString())).toBe(false);

    const statsRes = await request(app).get(`/api/responses/stats?formId=${formId}`).set("Authorization", `Bearer ${ownerToken}`);
    const before = statsRes.body.stats.total;

    // Restore and confirm it re-appears (bounds the exclusion test: it's the flag, not a fluke).
    await request(app)
      .post(`/api/responses/bulk`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ target: { ids: [resp._id.toString()] }, action: { type: "restore" } });

    const listAfterRestore = await request(app).get(`/api/responses?formId=${formId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(listAfterRestore.body.data.some((r: any) => r._id === resp._id.toString())).toBe(true);

    const statsAfterRestore = await request(app).get(`/api/responses/stats?formId=${formId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(statsAfterRestore.body.stats.total).toBe(before + 1);
  });
});
