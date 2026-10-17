import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import ResponseModel from "../models/Response";
import Notification from "../models/Notification";
import { generateToken } from "../utils/generateToken";

// QA D8-001: a "New Response Received" notification carried no formId, so the bell could not link anywhere. Every notification about a
// form or a response now says which one, and the list endpoint returns both ids.
let mongoServer: MongoMemoryServer;
let token: string;
let owner: any;
let ws: any;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  owner = await User.create({ firebaseUid: "uid-nl", fullName: "Owner NL", email: "owner-nl@test.com", role: "admin" });
  ws = await Workspace.create({ name: "NL Workspace", slug: "nl-workspace", owner: owner._id });
  owner.workspaceId = ws._id;
  await owner.save();
  token = generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role });
}, 900000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe("notifications link to their form and response", () => {
  it("a new public response notifies the owner with the form and the response, and the list returns both", async () => {
    const created = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${token}`)
      .set("x-workspace-slug", ws.slug)
      .send({ title: "Link form", fields: [{ label: "Name", type: "short_text", required: false }], settings: { honeypotEnabled: true } });
    expect(created.status).toBe(201);
    const formId = created.body.form._id;
    const published = await request(app).post(`/api/forms/${formId}/publish`).set("Authorization", `Bearer ${token}`).set("x-workspace-slug", ws.slug);
    expect(published.status).toBe(200);

    const submit = await request(app).post(`/api/public/${published.body.slug}/submit`).field("data", JSON.stringify({ Name: "Asha" }));
    expect(submit.status).toBe(200);
    const response = await ResponseModel.findOne({ formId });

    const stored = await Notification.findOne({ userId: owner._id, type: "form_activity" });
    expect(String(stored?.formId)).toBe(formId);
    expect(String(stored?.responseId)).toBe(String(response?._id));

    const list = await request(app).get("/api/notifications").set("Authorization", `Bearer ${token}`).set("x-workspace-slug", ws.slug);
    expect(list.status).toBe(200);
    const item = list.body.notifications.find((n: any) => n.type === "form_activity");
    expect(item).toMatchObject({ formId, responseId: String(response?._id) });
  });

  it("a notification without a form or response simply omits the fields", async () => {
    await Notification.create({ userId: owner._id, workspaceId: ws._id, type: "welcome", title: "Welcome", message: "Hi" });
    const list = await request(app).get("/api/notifications").set("Authorization", `Bearer ${token}`).set("x-workspace-slug", ws.slug);
    const welcome = list.body.notifications.find((n: any) => n.type === "welcome");
    expect(welcome).toBeDefined();
    expect(welcome).not.toHaveProperty("formId");
    expect(welcome).not.toHaveProperty("responseId");
  });
});
