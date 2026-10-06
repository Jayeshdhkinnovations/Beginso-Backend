// View counting for the completion rate: once per IP per form per hour, only for open forms.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { RateLimitBucket } from "../models/RateLimitBucket";
import { clearRateLimitStore } from "../middleware/rateLimiter";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-form-views";

let mongoServer: MongoMemoryServer;
let owner: any;
let ws: any;
let form: any;

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User, Workspace, Membership, Form, ResponseModel, RateLimitBucket].map((m: any) => m.init()));
});

beforeEach(async () => {
  await clearRateLimitStore();
  await Promise.all([Form, ResponseModel, Membership, Workspace, User].map((m: any) => m.deleteMany({})));
  owner = await User.create({ firebaseUid: "uid-views", fullName: "own", email: "own@views.test", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "V", slug: "views-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  form = await Form.create({
    title: "Viewed",
    workspaceId: ws._id,
    createdBy: owner._id,
    status: "published",
    slug: "views-form",
    publishedSlug: "views-form",
    fields: [{ fieldId: "f", label: "Q", type: "short_text", required: false }],
  });
});

afterEach(() => {
  delete process.env.PROXY_SHARED_SECRET;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const views = async () => ((await Form.findById(form._id).lean()) as any).viewsCount;
const view = (headers: Record<string, string> = {}, slug = "views-form") => request(app).post(`/api/public/${slug}/view`).set(headers);
const overview = () =>
  request(app)
    .get(`/api/forms/${form._id}/overview`)
    .set("Authorization", `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role })}`)
    .set("x-workspace-id", String(ws._id));

describe("view counting", () => {
  it("counts one view per IP per hour: reloads do not inflate it, a new visitor does", async () => {
    process.env.PROXY_SHARED_SECRET = "views-secret";
    const visitor = (ip: string) => ({ "x-proxy-secret": "views-secret", "x-client-ip": ip });
    expect((await view(visitor("203.0.113.1"))).status).toBe(204);
    await view(visitor("203.0.113.1"));
    await view(visitor("203.0.113.1"));
    expect(await views()).toBe(1);
    await view(visitor("203.0.113.2"));
    expect(await views()).toBe(2);
  });

  it("tolerates ?embed=1: still 204 and counts exactly once", async () => {
    process.env.PROXY_SHARED_SECRET = "views-secret";
    const h = { "x-proxy-secret": "views-secret", "x-client-ip": "203.0.113.9" };
    expect((await request(app).post("/api/public/views-form/view?embed=1").set(h)).status).toBe(204);
    await request(app).post("/api/public/views-form/view?embed=1").set(h);
    expect(await views()).toBe(1);
  });

  it("always answers 204 and counts nothing for an unknown, draft or closed form", async () => {
    expect((await view({}, "no-such-form")).status).toBe(204);
    await Form.updateOne({ _id: form._id }, { status: "closed" });
    expect((await view()).status).toBe(204);
    await Form.updateOne({ _id: form._id }, { status: "draft" });
    expect((await view()).status).toBe(204);
    expect(await views()).toBe(0);
  });
});

describe("completion rate on the form overview", () => {
  it("is null until a view is counted, then responses divided by views, capped at 100", async () => {
    await ResponseModel.create([{ formId: form._id, answers: {} }, { formId: form._id, answers: {} }]);
    expect((await overview()).body.overview.completionRate).toBeNull();

    await Form.updateOne({ _id: form._id }, { $set: { viewsCount: 8 } });
    expect((await overview()).body.overview.completionRate).toBe(25);

    await Form.updateOne({ _id: form._id }, { $set: { viewsCount: 1 } }); // more responses than views (older responses)
    expect((await overview()).body.overview.completionRate).toBe(100);
  });
});
