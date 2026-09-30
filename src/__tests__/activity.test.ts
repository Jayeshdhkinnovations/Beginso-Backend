import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { Event } from "../models/Event";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;
let ownerToken: string;
let ownerId: string;
let memberId: string;
let workspaceId: string;
let formId: string;

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const owner = await User.create({ firebaseUid: "act-owner-uid", fullName: "Owner", email: "act-owner@test.com", role: "admin" });
  const member = await User.create({ firebaseUid: "act-member-uid", fullName: "Member", email: "act-member@test.com", role: "admin" });
  ownerId = owner._id.toString();
  memberId = member._id.toString();

  const ws = await Workspace.create({ name: "Activity Workspace", owner: owner._id });
  workspaceId = (ws._id as mongoose.Types.ObjectId).toString();
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  await Membership.create({ userId: member._id, workspaceId: ws._id, role: "member" });

  const form = await Form.create({
    title: "Activity Form",
    workspaceId: ws._id,
    status: "published",
    publishedSlug: "activity-form-slug",
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
  });
  formId = (form._id as mongoose.Types.ObjectId).toString();

  ownerToken = generateToken({ id: ownerId, email: owner.email, role: owner.role });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe("GET /api/responses/:id/activity", () => {
  it("submitting through the public form produces a 'submitted' activity entry", async () => {
    const submitRes = await request(app).post(`/api/public/activity-form-slug/submit`).send({ Name: "Anon" });
    expect(submitRes.status).toBe(200);
    const responseId = submitRes.body.submission._id;

    const res = await request(app).get(`/api/responses/${responseId}/activity`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.activity.length).toBeGreaterThanOrEqual(1);
    expect(res.body.activity[0].type).toBe("submitted");
  });

  it("returns entries in reverse-chronological order (newest first — Sprint 12 close-out change)", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });

    await request(app).patch(`/api/responses/${resp._id}`).set("Authorization", `Bearer ${ownerToken}`).send({ status: "in_progress" });
    await request(app).patch(`/api/responses/${resp._id}`).set("Authorization", `Bearer ${ownerToken}`).send({ assigneeId: memberId });
    await request(app).patch(`/api/responses/${resp._id}`).set("Authorization", `Bearer ${ownerToken}`).send({ assigneeId: null });

    const res = await request(app).get(`/api/responses/${resp._id}/activity`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const types = res.body.activity.map((a: any) => a.type);
    expect(types).toEqual(["unassigned", "assigned", "stage_changed"]);

    const times = res.body.activity.map((a: any) => new Date(a.at).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }
  });

  it("note creation produces a note_added entry", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    await request(app).post(`/api/responses/${resp._id}/notes`).set("Authorization", `Bearer ${ownerToken}`).send({ body: "hi" });

    const res = await request(app).get(`/api/responses/${resp._id}/activity`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.body.activity.map((a: any) => a.type)).toContain("note_added");
  });

  it("never includes a raw IP anywhere in the output", async () => {
    const resp = await ResponseModel.create({ formId, answers: {} });
    await Event.create({
      workspaceId,
      actorId: ownerId,
      actorEmail: "owner@test.com",
      actorName: "Owner",
      action: "response.status_change",
      targetId: resp._id.toString(),
      targetType: "response",
      targetLabel: resp._id.toString(),
      metadata: { status: "in_progress" },
      ip: "abcdef1234hash", // hashed value, as always stored — must still never surface
    });

    const res = await request(app).get(`/api/responses/${resp._id}/activity`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const asString = JSON.stringify(res.body);
    expect(asString).not.toContain("abcdef1234hash");
    expect(asString.toLowerCase()).not.toContain('"ip"');
  });

  it("actorRemoved is true once the actor is no longer a workspace member", async () => {
    const leaver = await User.create({ firebaseUid: "act-leaver-uid", fullName: "Leaver", email: "act-leaver@test.com", role: "admin" });
    await Membership.create({ userId: leaver._id, workspaceId, role: "member" });

    const resp = await ResponseModel.create({ formId, answers: {} });
    await Event.create({
      workspaceId,
      actorId: leaver._id,
      actorEmail: leaver.email,
      actorName: leaver.fullName,
      action: "response.status_change",
      targetId: resp._id.toString(),
      targetType: "response",
      targetLabel: resp._id.toString(),
      metadata: { status: "in_progress" },
    });

    // Leaves the workspace.
    await Membership.deleteOne({ userId: leaver._id, workspaceId });

    const res = await request(app).get(`/api/responses/${resp._id}/activity`).set("Authorization", `Bearer ${ownerToken}`);
    const entry = res.body.activity.find((a: any) => a.type === "stage_changed");
    expect(entry.actorRemoved).toBe(true);
  });
});
