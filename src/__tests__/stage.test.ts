import request from "supertest";
import mongoose from "mongoose";
// Bypasses jest.config.ts's shared-mongod shim (which maps `mongodb-memory-server` to a standalone
// instance) because deleteStage runs inside a real multi-document transaction, which only a
// replica-set mongod supports. `mongodb-memory-server-core` is a different package name so the
// moduleNameMapper (exact match on "mongodb-memory-server") does not intercept this import.
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import StageModel from "../models/Stage";
import { Event } from "../models/Event";
import { generateToken } from "../utils/generateToken";
import { StageService } from "../services/stage.service";

jest.setTimeout(120000);

let replSet: MongoMemoryReplSet;

let ownerToken: string;
let adminToken: string;
let memberToken: string;
let workspaceId: string;
let formId: string;

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri("stage_test"));

  const owner = await User.create({
    firebaseUid: "stage-owner-uid",
    fullName: "Owner",
    email: "owner-stage@test.com",
    role: "admin",
  });
  const admin = await User.create({
    firebaseUid: "stage-admin-uid",
    fullName: "Admin",
    email: "admin-stage@test.com",
    role: "admin",
  });
  const member = await User.create({
    firebaseUid: "stage-member-uid",
    fullName: "Member",
    email: "member-stage@test.com",
    role: "admin",
  });

  const ws = await Workspace.create({ name: "Stage Workspace", owner: owner._id });
  workspaceId = (ws._id as mongoose.Types.ObjectId).toString();

  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  await Membership.create({ userId: admin._id, workspaceId: ws._id, role: "admin" });
  await Membership.create({ userId: member._id, workspaceId: ws._id, role: "member" });

  const form = await Form.create({
    title: "Stage Form",
    workspaceId: ws._id,
    status: "published",
    publishedSlug: "stage-form-slug",
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
  });
  formId = (form._id as mongoose.Types.ObjectId).toString();

  ownerToken = generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role });
  adminToken = generateToken({ id: admin._id.toString(), email: admin.email, role: admin.role });
  memberToken = generateToken({ id: member._id.toString(), email: member.email, role: member.role });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

describe("GET /api/workspaces/:workspaceId/stages", () => {
  it("seeds and returns the 3 default stages in order for any workspace member", async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/stages`)
      .set("Authorization", `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.stages.length).toBe(3);
    expect(res.body.stages.map((s: any) => s.category)).toEqual(["new", "in_progress", "completed"]);
    expect(res.body.stages[0].isDefault).toBe(true);
  });

  it("always returns >=1 stage even if called repeatedly (idempotent seeding)", async () => {
    await request(app).get(`/api/workspaces/${workspaceId}/stages`).set("Authorization", `Bearer ${memberToken}`);
    const res = await request(app).get(`/api/workspaces/${workspaceId}/stages`).set("Authorization", `Bearer ${memberToken}`);
    expect(res.body.stages.length).toBe(3);
  });
});

describe("Stage CRUD permission gating (Owner/Admin only)", () => {
  it("rejects POST from a member with 403", async () => {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/stages`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Blocked", colour: "rose", category: "new" });
    expect(res.status).toBe(403);
  });

  it("allows POST from an admin", async () => {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/stages`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Qualified", colour: "violet", category: "in_progress" });
    expect(res.status).toBe(201);
    expect(res.body.stage.name).toBe("Qualified");
    expect(res.body.stage.isDefault).toBe(false);
  });
});

describe("PATCH /api/workspaces/:workspaceId/stages/:id", () => {
  it("updates name/colour and, on category change, re-syncs status of responses on that stage", async () => {
    const stage = await StageModel.create({
      workspaceId,
      name: "Reviewing",
      colour: "amber",
      category: "in_progress",
      isDefault: false,
      order: 10,
    });
    const resp = await ResponseModel.create({
      formId,
      answers: { Name: "A" },
      stageId: stage._id,
      status: "in_progress",
    });

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/stages/${stage._id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "completed" });

    expect(res.status).toBe(200);
    expect(res.body.stage.category).toBe("completed");

    const updatedResp = await ResponseModel.findById(resp._id);
    expect(updatedResp?.status).toBe("completed");
  });

  it("rejects update from a member with 403", async () => {
    const stages = await StageModel.find({ workspaceId }).limit(1);
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/stages/${stages[0]._id}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Nope" });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/workspaces/:workspaceId/stages/order", () => {
  it("reorders stages to the given sequence", async () => {
    const stages = await StageModel.find({ workspaceId }).sort({ order: 1 });
    const reversedIds = stages.map((s) => s._id.toString()).reverse();

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/stages/order`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ orderedIds: reversedIds });

    expect(res.status).toBe(200);
    const stored = await StageModel.find({ workspaceId }).sort({ order: 1 });
    expect(stored.map((s) => s._id.toString())).toEqual(reversedIds);
  });

  it("rejects an orderedIds list that does not match the workspace's current stage ids", async () => {
    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/stages/order`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ orderedIds: [new mongoose.Types.ObjectId().toString()] });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/workspaces/:workspaceId/stages/:id — rejection cases", () => {
  it("returns 409 when deleting the default stage", async () => {
    const defaultStage = await StageModel.findOne({ workspaceId, isDefault: true });
    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/stages/${defaultStage!._id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CANNOT_DELETE_DEFAULT_STAGE");
  });

  it("returns 409 when deleting the last remaining stage of a category", async () => {
    // Isolated workspace/stage set so other tests' custom stages cannot accidentally satisfy
    // "a sibling exists in this category".
    const owner2 = await User.create({ firebaseUid: "iso-owner", fullName: "Iso", email: "iso-owner@test.com", role: "admin" });
    const ws2 = await Workspace.create({ name: "Isolated WS", owner: owner2._id });
    await Membership.create({ userId: owner2._id, workspaceId: ws2._id, role: "owner" });
    const token2 = generateToken({ id: owner2._id.toString(), email: owner2.email, role: owner2.role });

    const stageService = new StageService();
    const seeded = await stageService.ensureDefaultStages((ws2._id as mongoose.Types.ObjectId).toString());
    const completedStage = seeded.find((s) => s.category === "completed")!;

    const res = await request(app)
      .delete(`/api/workspaces/${ws2._id}/stages/${completedStage._id}`)
      .set("Authorization", `Bearer ${token2}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CANNOT_DELETE_LAST_OF_CATEGORY");
  });

  it("returns 400 when the stage has responses and reassignTo is missing", async () => {
    const stage = await StageModel.create({ workspaceId, name: "HasResponses", colour: "sky", category: "new", isDefault: false, order: 99 });
    await ResponseModel.create({ formId, answers: { Name: "X" }, stageId: stage._id, status: "new" });

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/stages/${stage._id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/workspaces/:workspaceId/stages/:id — reassign-and-delete atomicity", () => {
  it("reassigns every response to reassignTo, syncs status, logs one event per response, and deletes the stage — all or nothing", async () => {
    const stage = await StageModel.create({ workspaceId, name: "Doomed", colour: "rose", category: "new", isDefault: false, order: 100 });
    const targetStage = await StageModel.create({ workspaceId, name: "Landing", colour: "teal", category: "in_progress", isDefault: false, order: 101 });

    const r1 = await ResponseModel.create({ formId, answers: { Name: "R1" }, stageId: stage._id, status: "new" });
    const r2 = await ResponseModel.create({ formId, answers: { Name: "R2" }, stageId: stage._id, status: "new" });

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/stages/${stage._id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reassignTo: targetStage._id.toString() });

    expect(res.status).toBe(204);

    const stillThere = await StageModel.findById(stage._id);
    expect(stillThere).toBeNull();

    const movedR1 = await ResponseModel.findById(r1._id);
    const movedR2 = await ResponseModel.findById(r2._id);
    expect(movedR1?.stageId?.toString()).toBe(targetStage._id.toString());
    expect(movedR1?.status).toBe("in_progress");
    expect(movedR2?.stageId?.toString()).toBe(targetStage._id.toString());
    expect(movedR2?.status).toBe("in_progress");

    const events = await Event.find({ targetType: "response", action: "response.stage_change", targetId: { $in: [r1._id.toString(), r2._id.toString()] } });
    expect(events.length).toBe(2);
    for (const ev of events) {
      expect(ev.metadata?.toStageId).toBe(targetStage._id.toString());
      expect(ev.metadata?.fromStageId).toBe(stage._id.toString());
    }
  });

  it("leaves everything unchanged when the transaction fails partway through", async () => {
    const stage = await StageModel.create({ workspaceId, name: "AlsoDoomed", colour: "rose", category: "new", isDefault: false, order: 102 });
    const targetStage = await StageModel.create({ workspaceId, name: "AlsoLanding", colour: "teal", category: "in_progress", isDefault: false, order: 103 });
    const r1 = await ResponseModel.create({ formId, answers: { Name: "R3" }, stageId: stage._id, status: "new" });

    const spy = jest.spyOn(Event, "insertMany").mockImplementationOnce(() => {
      throw new Error("simulated failure mid-transaction");
    });

    const stageService = new StageService();
    await expect(
      stageService.deleteStage(workspaceId, stage._id.toString(), {
        reassignTo: targetStage._id.toString(),
        actor: { id: null, email: "test@test.com", name: "Test" },
      })
    ).rejects.toThrow("simulated failure mid-transaction");

    spy.mockRestore();

    // Nothing committed: stage still exists, response never moved.
    const stageStillThere = await StageModel.findById(stage._id);
    expect(stageStillThere).not.toBeNull();

    const untouchedResp = await ResponseModel.findById(r1._id);
    expect(untouchedResp?.stageId?.toString()).toBe(stage._id.toString());
    expect(untouchedResp?.status).toBe("new");
  });
});

describe("Legacy status-based endpoints keep working when a workspace renames its stages", () => {
  let customWsId: string;
  let customFormId: string;
  let customOwnerToken: string;
  let completedStageId: string;

  beforeAll(async () => {
    const owner = await User.create({ firebaseUid: "custom-owner", fullName: "Custom Owner", email: "custom-owner@test.com", role: "admin" });
    const ws = await Workspace.create({ name: "Custom Names WS", owner: owner._id });
    customWsId = (ws._id as mongoose.Types.ObjectId).toString();
    await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
    customOwnerToken = generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role });

    const form = await Form.create({ title: "Custom Form", workspaceId: ws._id, status: "published", publishedSlug: "custom-form-slug", fields: [] });
    customFormId = (form._id as mongoose.Types.ObjectId).toString();

    // Seed, then rename the default stages to workspace-specific labels — the category (what
    // status derives from) is untouched by a rename.
    const stageService = new StageService();
    const stages = await stageService.ensureDefaultStages(customWsId);
    await StageModel.updateOne({ _id: stages.find((s) => s.category === "new")!._id }, { $set: { name: "Inbox" } });
    await StageModel.updateOne({ _id: stages.find((s) => s.category === "in_progress")!._id }, { $set: { name: "Cooking" } });
    await StageModel.updateOne({ _id: stages.find((s) => s.category === "completed")!._id }, { $set: { name: "Shipped" } });
    completedStageId = stages.find((s) => s.category === "completed")!._id.toString();
  });

  it("PATCH /api/responses/:id with legacy {status} still lands the response on the renamed stage of that category", async () => {
    const resp = await ResponseModel.create({ formId: customFormId, answers: {}, status: "new" });

    const res = await request(app)
      .patch(`/api/responses/${resp._id}`)
      .set("Authorization", `Bearer ${customOwnerToken}`)
      .send({ status: "completed" });

    expect(res.status).toBe(200);
    expect(res.body.response.status).toBe("completed");
    expect(res.body.response.stageId).toBe(completedStageId);
    expect(res.body.response.stage.name).toBe("Shipped");

    const inDb = await ResponseModel.findById(resp._id);
    expect(inDb?.stageId?.toString()).toBe(completedStageId);
  });

  it("GET /api/responses?status=completed and /stats still filter/count correctly by the renamed stage's category", async () => {
    const listRes = await request(app)
      .get(`/api/responses?formId=${customFormId}&status=completed`)
      .set("Authorization", `Bearer ${customOwnerToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBeGreaterThanOrEqual(1);
    expect(listRes.body.data.every((r: any) => r.status === "completed")).toBe(true);

    const statsRes = await request(app)
      .get(`/api/responses/stats?formId=${customFormId}`)
      .set("Authorization", `Bearer ${customOwnerToken}`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.stats.completed).toBeGreaterThanOrEqual(1);
    expect(statsRes.body.stats.total).toBe(statsRes.body.stats.new + statsRes.body.stats.in_progress + statsRes.body.stats.completed);
    const shippedEntry = statsRes.body.stats.stageBreakdown.find((s: any) => s.stageId === completedStageId);
    expect(shippedEntry.name).toBe("Shipped");
    expect(shippedEntry.count).toBeGreaterThanOrEqual(1);

    // V2 contract (design.md §11.2): the response is flat, not nested under `stats`, and the
    // primary fields are `byCategory`/`byStage`/`unread` — this is what the frontend actually
    // reads (src/types/response.ts ResponseStats). Regression for the bug where this endpoint
    // only ever returned the legacy nested shape, silently zeroing every Inbox stat card.
    expect(statsRes.body.total).toBe(statsRes.body.stats.total);
    expect(statsRes.body.byCategory).toEqual({
      new: statsRes.body.stats.new,
      in_progress: statsRes.body.stats.in_progress,
      completed: statsRes.body.stats.completed,
    });
    const shippedByStage = statsRes.body.byStage.find((s: any) => s.stageId === completedStageId);
    expect(shippedByStage.name).toBe("Shipped");
    expect(shippedByStage.count).toBeGreaterThanOrEqual(1);
    expect(typeof statsRes.body.unread).toBe("number");
  });
});
