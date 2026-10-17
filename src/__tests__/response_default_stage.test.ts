// QA D5-007 (high): every new response to a workspace form had no stage, so the drawer said "Unknown stage" and the Board never
// listed it. A new response now starts in the workspace's default stage; a personal form's response still has no stage.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import StageModel from "../models/Stage";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { generateToken } from "../utils/generateToken";
import { clearRateLimitStore } from "../middleware/rateLimiter";

process.env.JWT_SECRET = "test-jwt-secret-key-for-default-stage";

let mongo: MongoMemoryServer;
let owner: any, ws: any, token: string;
let n = 0;

const mkForm = (extra: any = {}) => {
  n += 1;
  return Form.create({
    title: "Stage form", createdBy: owner._id, status: "published", slug: `ds-${n}`, publishedSlug: `ds-${n}`,
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
    ...extra,
  });
};
const submit = (slug: string) => request(app).post(`/api/public/${slug}/submit`).send({ f1: "Asha" });

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  owner = await User.create({ firebaseUid: "uid-ds-owner", fullName: "Owner", email: "ds-owner@test.com", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "DS WS", slug: "ds-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  token = generateToken({ id: owner._id.toString(), email: owner.email, role: "user" });
});
beforeEach(() => clearRateLimitStore());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("a new response's starting stage", () => {
  it("a workspace form's response is filed under the workspace's default stage, and the list shows that stage", async () => {
    const f: any = await mkForm({ workspaceId: ws._id });
    const res = await submit(f.publishedSlug);
    expect(res.status).toBe(200);
    const stored: any = await ResponseModel.findOne({ formId: f._id }).lean();
    const def: any = await StageModel.findOne({ workspaceId: ws._id, isDefault: true }).lean();
    expect(def).toBeTruthy();
    expect(String(stored.stageId)).toBe(String(def._id));
    expect(stored.status).toBe(def.category);

    const list = await request(app).get(`/api/responses?formId=${f._id}`).set({ Authorization: `Bearer ${token}`, "x-workspace-slug": "ds-ws" });
    expect(list.status).toBe(200);
    const row = (list.body.data ?? list.body.responses)[0];
    expect(row.stage).toMatchObject({ id: String(def._id), name: def.name });
  });

  it("filtering the list by that stage (what the Board does) finds the new response", async () => {
    const f: any = await mkForm({ workspaceId: ws._id });
    await submit(f.publishedSlug);
    const def: any = await StageModel.findOne({ workspaceId: ws._id, isDefault: true }).lean();
    const list = await request(app).get(`/api/responses?formId=${f._id}&stageId=${def._id}`).set({ Authorization: `Bearer ${token}`, "x-workspace-slug": "ds-ws" });
    expect((list.body.data ?? list.body.responses)).toHaveLength(1);
  });

  it("a personal form's response has no stage (status is the whole story there)", async () => {
    const f: any = await mkForm({ workspaceId: null });
    expect((await submit(f.publishedSlug)).status).toBe(200);
    const stored: any = await ResponseModel.findOne({ formId: f._id }).lean();
    expect(stored.stageId ?? null).toBeNull();
    expect(stored.status).toBe("new");
  });

  it("a workspace with no stages yet gets the three default stages on its first submission", async () => {
    const ws2: any = await Workspace.create({ name: "DS WS 2", slug: "ds-ws-2", timezone: "UTC", owner: owner._id });
    const f: any = await mkForm({ workspaceId: ws2._id });
    expect(await StageModel.countDocuments({ workspaceId: ws2._id })).toBe(0);
    expect((await submit(f.publishedSlug)).status).toBe(200);
    expect(await StageModel.countDocuments({ workspaceId: ws2._id })).toBe(3);
    const stored: any = await ResponseModel.findOne({ formId: f._id }).lean();
    expect(stored.stageId).toBeTruthy();
  });
});
