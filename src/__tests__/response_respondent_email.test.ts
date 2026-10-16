// QA A6-007: a signed-in-only form stores the respondent's account email, but the response list and detail never returned
// it, so the owner's inbox could not show who answered.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-respondent-email";

let mongoServer: MongoMemoryServer;
let owner: any;
let ws: any;
let form: any;

const h = () => ({ Authorization: `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role })}`, "x-workspace-id": ws._id.toString() });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  owner = await User.create({ firebaseUid: "uid-re-owner", fullName: "RE Owner", email: "re-owner@test.com", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "RE WS", slug: "re-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  form = await Form.create({ title: "Login form", workspaceId: ws._id, createdBy: owner._id, fields: [{ fieldId: "f1", label: "Comment", type: "short_text", required: false }] });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("respondentEmail is part of the response payload", () => {
  it("is returned by the list and the detail for a response that has one, and null when it does not", async () => {
    const withEmail: any = await ResponseModel.create({ formId: form._id, answers: { Comment: "Nice" }, respondentEmail: "person@example.com" });
    const anonymous: any = await ResponseModel.create({ formId: form._id, answers: { Comment: "Fine" } });

    const list = await request(app).get(`/api/responses?formId=${form._id}`).set(h());
    expect(list.status).toBe(200);
    const byId = (id: any) => list.body.data.find((r: any) => r._id === String(id));
    expect(byId(withEmail._id).respondentEmail).toBe("person@example.com");
    expect(byId(anonymous._id).respondentEmail).toBeNull();

    const detail = await request(app).get(`/api/responses/${withEmail._id}`).set(h());
    expect(detail.status).toBe(200);
    expect((detail.body.response ?? detail.body).respondentEmail).toBe("person@example.com");
    const anonDetail = await request(app).get(`/api/responses/${anonymous._id}`).set(h());
    expect((anonDetail.body.response ?? anonDetail.body).respondentEmail).toBeNull();
  });
});
