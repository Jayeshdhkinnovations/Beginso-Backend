// S-20: what an anonymous visitor can make the public form endpoints do.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import app from "../app";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { clearRateLimitStore } from "../middleware/rateLimiter";
import { generateToken } from "../utils/generateToken";
import { isSafePattern } from "../utils/uploadLimits";

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "beginso-pub-"));
process.env.UPLOAD_DIR = uploadDir;
process.env.JWT_SECRET = "test-jwt-secret-key-for-public-hardening";

let mongoServer: MongoMemoryServer;
let owner: any;
let ws: any;

const files = (dir = uploadDir): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      e.isDirectory() ? walk(p) : out.push(p);
    }
  };
  walk(dir);
  return out;
};

const mkForm = (extra: any = {}) =>
  Form.create({
    title: "Public",
    workspaceId: ws._id,
    createdBy: owner._id,
    status: "published",
    slug: `pub-${Math.random().toString(36).slice(2, 8)}`,
    publishedSlug: `pub-${Math.random().toString(36).slice(2, 8)}`,
    fields: [
      { fieldId: "name", label: "Name", type: "short_text", required: false },
      { fieldId: "phone", label: "Phone", type: "phone", required: false, pattern: "^[0-9]{10}$" },
      { fieldId: "cv", label: "CV", type: "file_upload", required: false },
    ],
    ...extra,
  });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Form, ResponseModel, Upload, User, Workspace, Membership].map((m: any) => m.init()));
});

beforeEach(async () => {
  await clearRateLimitStore();
  await Promise.all([Form, ResponseModel, Upload, Membership, Workspace, User].map((m: any) => m.deleteMany({})));
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  process.env.RATE_LIMIT_MAX = "0";
  owner = await User.create({ firebaseUid: "uid-pub", fullName: "own", email: "own@pub.test", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "Pub", slug: "pub-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
});

afterEach(() => {
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.MAX_UPLOAD_MB;
  delete process.env.MAX_UPLOAD_FILES;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

const submit = (slug: string) => request(app).post(`/api/public/${slug}/submit`);
const pdf = (bytes = 100) => Buffer.alloc(bytes, "x");

describe("nothing is written before the form is known to accept responses", () => {
  it("a draft form and an unknown slug get 404 and no file reaches the disk", async () => {
    const draft: any = await mkForm({ status: "draft", publishedSlug: undefined, slug: "draft-slug" });
    const a = await submit(draft.slug).field("data", "{}").attach("CV", pdf(), "cv.pdf");
    const b = await submit("no-such-form").field("data", "{}").attach("CV", pdf(), "cv.pdf");
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(files()).toEqual([]);
  });

  it("a closed form takes no files either", async () => {
    const closed: any = await mkForm({ status: "closed" });
    const res = await submit(closed.publishedSlug).field("data", "{}").attach("CV", pdf(), "cv.pdf");
    expect(res.status).toBe(404);
    expect(files()).toEqual([]);
  });
});

describe("size and count limits", () => {
  it("a file over MAX_UPLOAD_MB is refused and leaves nothing behind", async () => {
    process.env.MAX_UPLOAD_MB = "1";
    const form: any = await mkForm();
    const res = await submit(form.publishedSlug).field("data", "{}").attach("CV", pdf(2 * 1024 * 1024), "big.pdf");
    expect(res.status).toBe(400);
    expect(files()).toEqual([]);
    expect(await ResponseModel.countDocuments({})).toBe(0);
  });

  it("more files than MAX_UPLOAD_FILES is refused", async () => {
    process.env.MAX_UPLOAD_FILES = "2";
    const form: any = await mkForm();
    const res = await submit(form.publishedSlug)
      .field("data", "{}")
      .attach("CV", pdf(), "1.pdf")
      .attach("CV2", pdf(), "2.pdf")
      .attach("CV3", pdf(), "3.pdf");
    expect(res.status).toBe(400);
    expect(files()).toEqual([]);
  });
});

describe("failed and discarded submissions clean up after themselves", () => {
  it("a validation failure removes the uploaded file, its folder and its upload row", async () => {
    const form: any = await mkForm();
    const res = await submit(form.publishedSlug)
      .field("data", JSON.stringify({ answers: [{ fieldId: "phone", value: "not-a-phone" }] }))
      .attach("CV", pdf(), "cv.pdf");
    expect(res.status).toBe(422);
    expect(files()).toEqual([]);
    expect(await Upload.countDocuments({})).toBe(0);
  });

  it("a honeypot hit stores nothing, not even the file", async () => {
    const form: any = await mkForm();
    const res = await submit(form.publishedSlug).field("data", "{}").field("_hp", "i am a bot").attach("CV", pdf(), "cv.pdf");
    expect(res.status).toBe(200);
    expect(files()).toEqual([]);
    expect(await ResponseModel.countDocuments({})).toBe(0);
  });

  it("a good submission keeps its file", async () => {
    const form: any = await mkForm();
    const res = await submit(form.publishedSlug).field("data", JSON.stringify({ answers: [{ fieldId: "name", value: "Ann" }] })).attach("CV", pdf(), "cv.pdf");
    expect(res.status).toBe(200);
    expect(files().some((f) => f.endsWith("cv.pdf"))).toBe(true);
  });
});

describe("answers are limited to the form's own questions", () => {
  it("unknown keys, including operator-looking ones, are not stored", async () => {
    const form: any = await mkForm();
    const res = await submit(form.publishedSlug).field(
      "data",
      JSON.stringify({ answers: [{ fieldId: "name", value: "Ann" }], $where: "1", "a.b": "x", injected: { $ne: 1 } })
    );
    expect(res.status).toBe(200);
    const stored: any = await ResponseModel.findOne({ formId: form._id }).lean();
    const keys = Object.keys(stored.answers);
    expect(keys).toEqual(["Name"]);
  });

  it("an oversized submission is refused", async () => {
    process.env.MAX_ANSWERS_BYTES = "200";
    const form: any = await mkForm();
    const res = await submit(form.publishedSlug).field("data", JSON.stringify({ answers: [{ fieldId: "name", value: "x".repeat(5000) }] }));
    delete process.env.MAX_ANSWERS_BYTES;
    expect([400, 413]).toContain(res.status);
    expect(await ResponseModel.countDocuments({})).toBe(0);
  });
});

describe("field patterns cannot hang the server (ReDoS)", () => {
  it("isSafePattern accepts ordinary patterns and refuses catastrophic ones", () => {
    for (const ok of ["^[0-9]{10}$", "^\\+?[0-9 ()-]{7,15}$", "^(\\d{3})-(\\d{4})$", "^[A-Z]{2}[0-9]{6}$"]) expect(isSafePattern(ok)).toBe(true);
    for (const bad of ["(a+)+$", "^(a*)*$", "(a|aa)+$", "^([a-z]+\\s?)+$", "(", "x".repeat(300)]) expect(isSafePattern(bad)).toBe(false);
  });

  it("saving a form with a catastrophic pattern is rejected", async () => {
    const token = generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role });
    const res = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${token}`)
      .set("x-workspace-id", ws._id.toString())
      .send({ title: "ReDoS", fields: [{ label: "Phone", type: "phone", required: false, pattern: "(a+)+$" }] });
    expect([400, 422]).toContain(res.status);
  });

  it("a catastrophic pattern that is already stored is never run", async () => {
    const form: any = await mkForm({
      fields: [{ fieldId: "phone", label: "Phone", type: "phone", required: false, pattern: "(a+)+$" }],
    });
    const started = Date.now();
    const res = await submit(form.publishedSlug).field("data", JSON.stringify({ answers: [{ fieldId: "phone", value: "a".repeat(40) + "!" }] }));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(res.status).toBeLessThan(500);
  });
});
