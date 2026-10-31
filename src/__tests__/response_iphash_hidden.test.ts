// ipHash (SHA-256 of the submitter's IP) is stored on every response for duplicate detection and rate limits, but it is never
// handed out: not in the responses list, the detail, the update responses, or the workspace data export, whatever the caller's role.
// respondentEmail is unchanged (it is still returned).
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { generateToken } from "../utils/generateToken";

const IP_HASH = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const ROLES = ["owner", "admin", "editor", "member", "viewer"] as const;

let mongoServer: MongoMemoryServer;
let ws: any;
let form: any;
let response: any;
const tokens: Record<string, string> = {};

const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
const contains = (value: unknown) => JSON.stringify(value).includes(IP_HASH) || JSON.stringify(value).includes("ipHash");

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  ws = await Workspace.create({ name: "IpHash WS", owner: new mongoose.Types.ObjectId() });
  for (const role of ROLES) {
    const user = await User.create({ firebaseUid: `uid-iph-${role}`, fullName: `${role} user`, email: `${role}@iph.test`, status: "active" });
    await Membership.create({ userId: user._id, workspaceId: ws._id, role });
    tokens[role] = generateToken({ id: user._id.toString(), email: user.email, role: "user" });
    if (role === "owner") await Workspace.updateOne({ _id: ws._id }, { owner: user._id });
  }
  form = await Form.create({
    title: "IpHash form",
    workspaceId: ws._id,
    status: "published",
    publishedSlug: "iph-form",
    fields: [{ fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: false, order: 0 }],
    pages: [{ id: "p1", order: 0, title: "Page" }],
  } as any);
  response = await ResponseModel.create({
    formId: form._id,
    answers: { Name: "Asha" },
    ipHash: IP_HASH,
    respondentEmail: "asha@example.com",
    reference: "#1",
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("ipHash stays stored", () => {
  it("is still on the stored response (duplicate detection and rate limits use it)", async () => {
    const stored = await ResponseModel.findById(response._id).lean();
    expect((stored as any).ipHash).toBe(IP_HASH);
  });
});

describe.each(ROLES)("ipHash is not returned to the %s role", (role) => {
  it("by the responses list", async () => {
    const res = await request(app).get("/api/responses").query({ formId: String(form._id) }).set(as(role));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("Asha"); // the response really is in the payload
    expect(contains(res.body)).toBe(false);
  });

  it("by the response detail, which still returns respondentEmail", async () => {
    const res = await request(app).get(`/api/responses/${response._id}`).set(as(role));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("asha@example.com");
    expect(contains(res.body)).toBe(false);
  });

  it("by the update response (a stage or status change)", async () => {
    const res = await request(app).patch(`/api/responses/${response._id}`).set(as(role)).send({ status: "in_progress" });
    expect(res.status).toBe(200);
    expect(contains(res.body)).toBe(false);
  });
});

describe("the workspace data export", () => {
  it("does not contain ipHash, but still contains the responses", async () => {
    const start = await request(app).post("/api/workspaces/current/export").set(as("owner"));
    expect(start.status).toBe(202);
    const jobId = start.body.exportJob.id;
    let file = "";
    for (let i = 0; i < 40 && !file; i++) {
      const status = await request(app).get("/api/workspaces/current/export/status").query({ jobId }).set(as("owner"));
      if (status.body?.exportJob?.status === "completed" || status.body?.status === "completed") file = "ready";
      else await new Promise((r) => setTimeout(r, 250));
    }
    expect(file).toBe("ready");
    const download = await request(app).get("/api/workspaces/current/export/file").query({ jobId }).set(as("owner")).buffer(true).parse((res, cb) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => cb(null, data));
    });
    expect(download.status).toBe(200);
    const text = String(download.body);
    expect(text).toContain("Asha");
    expect(text).not.toContain(IP_HASH);
    expect(text).not.toContain("ipHash");
  }, 30_000);
});
