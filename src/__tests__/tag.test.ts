import request from "supertest";
import mongoose from "mongoose";
// Real replica-set mongod, same as stage.test.ts: mergeTag runs inside a multi-document
// transaction, which mongodb-memory-server-core's standalone (the shared shim) can't support.
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import TagModel from "../models/Tag";
import { generateToken } from "../utils/generateToken";

jest.setTimeout(120000);

let replSet: MongoMemoryReplSet;

let ownerToken: string;
let memberToken: string;
let workspaceId: string;
let formId: string;

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri("tag_test"));

  const owner = await User.create({ firebaseUid: "tag-owner-uid", fullName: "Owner", email: "owner-tag@test.com", role: "admin" });
  const member = await User.create({ firebaseUid: "tag-member-uid", fullName: "Member", email: "member-tag@test.com", role: "admin" });

  const ws = await Workspace.create({ name: "Tag Workspace", owner: owner._id });
  workspaceId = (ws._id as mongoose.Types.ObjectId).toString();

  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  await Membership.create({ userId: member._id, workspaceId: ws._id, role: "member" });

  const form = await Form.create({
    title: "Tag Form",
    workspaceId: ws._id,
    status: "published",
    publishedSlug: "tag-form-slug",
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
  });
  formId = (form._id as mongoose.Types.ObjectId).toString();

  ownerToken = generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role });
  memberToken = generateToken({ id: member._id.toString(), email: member.email, role: member.role });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

describe("Tag CRUD", () => {
  it("member (responses:write tier) can create a tag inline", async () => {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/tags`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "VIP", colour: "amber" });
    expect(res.status).toBe(201);
    expect(res.body.tag.name).toBe("VIP");
    expect(res.body.tag.usageCount).toBe(0);
  });

  it("rejects a duplicate name case-insensitively within the same workspace", async () => {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/tags`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "vip", colour: "rose" });
    expect(res.status).toBe(409);
  });

  it("rejects rename/recolour from a non-admin member with 403", async () => {
    const tag = await TagModel.findOne({ workspaceId, nameLower: "vip" });
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/tags/${tag!._id}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ colour: "blue" });
    expect(res.status).toBe(403);
  });

  it("allows rename/recolour from the owner", async () => {
    const tag = await TagModel.findOne({ workspaceId, nameLower: "vip" });
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/tags/${tag!._id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ colour: "blue" });
    expect(res.status).toBe(200);
    expect(res.body.tag.colour).toBe("blue");
  });

  it("GET returns usageCount reflecting responses currently tagged", async () => {
    const tag = await TagModel.findOne({ workspaceId, nameLower: "vip" });
    const resp = await ResponseModel.create({ formId, answers: {}, tagIds: [tag!._id] });

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/tags`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
    const vip = res.body.tags.find((t: any) => t._id === tag!._id.toString());
    expect(vip.usageCount).toBe(1);

    await ResponseModel.deleteOne({ _id: resp._id });
  });

  it("delete detaches the tag from every response and reports usageCount", async () => {
    const tag = await TagModel.create({ workspaceId, name: "ToDelete", colour: "slate" });
    const r1 = await ResponseModel.create({ formId, answers: {}, tagIds: [tag._id] });
    const r2 = await ResponseModel.create({ formId, answers: {}, tagIds: [tag._id] });

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/tags/${tag._id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.usageCount).toBe(2);

    const dbR1 = await ResponseModel.findById(r1._id);
    const dbR2 = await ResponseModel.findById(r2._id);
    expect(dbR1!.tagIds).toEqual([]);
    expect(dbR2!.tagIds).toEqual([]);
    expect(await TagModel.findById(tag._id)).toBeNull();
  });
});

describe("Tag merge (atomic)", () => {
  it("reassigns every response from the source tag onto the target and removes the source", async () => {
    const source = await TagModel.create({ workspaceId, name: "Source", colour: "amber" });
    const target = await TagModel.create({ workspaceId, name: "Target", colour: "emerald" });
    const r1 = await ResponseModel.create({ formId, answers: {}, tagIds: [source._id] });
    // Already carries both: merge must not create a duplicate.
    const r2 = await ResponseModel.create({ formId, answers: {}, tagIds: [source._id, target._id] });

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/tags/${source._id}/merge`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ into: target._id.toString() });

    expect(res.status).toBe(200);
    expect(res.body.mergedCount).toBe(2);

    const dbR1 = await ResponseModel.findById(r1._id);
    const dbR2 = await ResponseModel.findById(r2._id);
    expect(dbR1!.tagIds.map((t) => t.toString())).toEqual([target._id.toString()]);
    expect(dbR2!.tagIds.map((t) => t.toString())).toEqual([target._id.toString()]);
    expect(await TagModel.findById(source._id)).toBeNull();
  });

  it("rejects merging a tag into itself", async () => {
    const tag = await TagModel.create({ workspaceId, name: "SelfMerge", colour: "amber" });
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/tags/${tag._id}/merge`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ into: tag._id.toString() });
    expect(res.status).toBe(400);
  });
});
