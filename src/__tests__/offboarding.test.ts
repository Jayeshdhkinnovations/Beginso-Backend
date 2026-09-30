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
import { generateToken } from "../utils/generateToken";
import { ResponseService } from "../services/response.service";

// Sprint 12, BE 0.6 (B3.3/F16) regression coverage for offboarding. response.service.ts's
// offboardMemberAssignments, team.controller.ts's removeMember (try/catch around it), and
// note.service.ts's authorRemoved are already correct and stable (Friday's work) — this is the
// "separate, later test pass" for them, not new behavior.

let mongoServer: MongoMemoryServer;
let ownerToken: string;
let ownerId: string;
let workspaceId: string;
let workspaceIdOther: string;

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const owner = await User.create({ firebaseUid: "off-owner-uid", fullName: "Owner", email: "off-owner@test.com", role: "admin" });
  ownerId = owner._id.toString();
  ownerToken = generateToken({ id: ownerId, email: owner.email, role: owner.role });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

const setupWorkspaceWithMember = async (suffix: string) => {
  const owner = await User.findById(ownerId);
  const ws = await Workspace.create({ name: `Offboard WS ${suffix}`, owner: owner!._id });
  await Membership.create({ userId: owner!._id, workspaceId: ws._id, role: "owner" });

  const member = await User.create({ firebaseUid: `off-member-uid-${suffix}`, fullName: "Member", email: `off-member-${suffix}@test.com`, role: "admin" });
  await Membership.create({ userId: member._id, workspaceId: ws._id, role: "member" });

  const form = await Form.create({
    title: `Offboard Form ${suffix}`,
    workspaceId: ws._id,
    status: "published",
    publishedSlug: `offboard-form-${suffix}`,
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
  });

  return { ws, member, form };
};

describe("Offboarding: assignment cleanup on member removal (B3.3/F16)", () => {
  it("removing a member with response assignments sets assigneeId: null, scoped to that workspace's forms only", async () => {
    const { ws, member, form } = await setupWorkspaceWithMember("scope");
    workspaceId = (ws._id as mongoose.Types.ObjectId).toString();

    // A second, unrelated workspace where the same user also holds an assignment.
    const { ws: otherWs, form: otherForm } = await setupWorkspaceWithMember("scope-other");
    await Membership.create({ userId: member._id, workspaceId: otherWs._id, role: "member" });
    workspaceIdOther = (otherWs._id as mongoose.Types.ObjectId).toString();

    const resp1 = await ResponseModel.create({ formId: form._id, answers: {}, assigneeId: member._id });
    const resp2 = await ResponseModel.create({ formId: form._id, answers: {}, assigneeId: member._id });
    const respOther = await ResponseModel.create({ formId: otherForm._id, answers: {}, assigneeId: member._id });

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/members/${member._id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);

    const r1 = await ResponseModel.findById(resp1._id).lean();
    const r2 = await ResponseModel.findById(resp2._id).lean();
    expect(r1!.assigneeId).toBeNull();
    expect(r2!.assigneeId).toBeNull();

    // Unaffected: the assignment lives on a form in a DIFFERENT workspace the member wasn't removed from.
    const rOther = await ResponseModel.findById(respOther._id).lean();
    expect(rOther!.assigneeId?.toString()).toBe(member._id.toString());
  });

  it("the removal itself succeeds even if offboardMemberAssignments throws", async () => {
    const { ws, member, form } = await setupWorkspaceWithMember("failsafe");
    const resp = await ResponseModel.create({ formId: form._id, answers: {}, assigneeId: member._id });

    const spy = jest
      .spyOn(ResponseService.prototype, "offboardMemberAssignments")
      .mockRejectedValueOnce(new Error("simulated offboarding failure"));

    const res = await request(app)
      .delete(`/api/workspaces/${ws._id}/members/${member._id}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The membership is still gone even though offboarding failed.
    expect(await Membership.findOne({ userId: member._id, workspaceId: ws._id })).toBeNull();

    spy.mockRestore();
  });

  it("an offboarded member's notes render authorRemoved: true on read", async () => {
    const { ws, member, form } = await setupWorkspaceWithMember("notes");
    const resp = await ResponseModel.create({ formId: form._id, answers: {} });
    const note = await Note.create({
      responseId: resp._id,
      authorId: member._id,
      authorName: member.fullName,
      body: "written before offboarding",
      mentionIds: [],
    });

    await request(app)
      .delete(`/api/workspaces/${ws._id}/members/${member._id}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const listRes = await request(app)
      .get(`/api/responses/${resp._id}/notes`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.status).toBe(200);
    const found = listRes.body.notes.find((n: any) => n.id === note._id.toString());
    expect(found).toBeDefined();
    expect(found.authorRemoved).toBe(true);
  });
});
