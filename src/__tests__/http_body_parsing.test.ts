// What the request parsers do for real requests: JSON bodies (express.json, i.e. body-parser), compressed JSON bodies, and multipart
// uploads (multer). Written so the same file can be run before and after a patch of body-parser or multer: both runs must pass.
import request from "supertest";
import mongoose from "mongoose";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app";
import User from "../models/User";
import Form from "../models/Form";
import Workspace from "../models/Workspace";
import ResponseModel from "../models/Response";
import { generateToken } from "../utils/generateToken";

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "beginso-bodyparse-"));
process.env.UPLOAD_DIR = uploadDir;

let mongoServer: MongoMemoryServer;
let token: string;
let formId: string;
const SLUG = "body-parsing-form";

// A tiny valid PNG (1x1), so the upload route's image check passes.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const user = await User.create({ firebaseUid: "uid-bodyparse", fullName: "Body Parse", email: "bodyparse@test.com", role: "admin", status: "active" });
  const ws = await Workspace.create({ name: "Body parse WS", owner: user._id });
  void ws;
  token = generateToken({ id: String(user._id), email: user.email, role: user.role });
  const form: any = await Form.create({
    title: "Body parsing",
    workspaceId: null,
    createdBy: user._id,
    status: "published",
    publishedSlug: SLUG,
    fields: [{ fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: true, order: 0 }],
    pages: [{ id: "p1", order: 0, title: "Page" }],
  } as any);
  formId = String(form._id);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

const stored = () => ResponseModel.find({ formId }).setOptions({ includeTest: true }).lean();

describe("JSON bodies (body-parser)", () => {
  it("a normal JSON body is parsed: the public submit stores the answer", async () => {
    const res = await request(app).post(`/api/public/${SLUG}/submit`).send({ Name: "Json Jane" });
    expect(res.status).toBe(200);
    const rows = await stored();
    expect(JSON.stringify(rows)).toContain("Json Jane");
  });

  it("malformed JSON is refused with a client error, not a crash", async () => {
    const res = await request(app).post(`/api/public/${SLUG}/submit`).set("Content-Type", "application/json").send("{ not json");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("a gzip-compressed JSON body is inflated and parsed", async () => {
    const body = zlib.gzipSync(Buffer.from(JSON.stringify({ Name: "Gzip Gus" })));
    const res = await request(app).post(`/api/public/${SLUG}/submit`).set("Content-Type", "application/json").set("Content-Encoding", "gzip").send(body);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await stored())).toContain("Gzip Gus");
  });

  it("a compressed body with extra bytes after it gets an answer promptly (no hang)", async () => {
    const body = Buffer.concat([zlib.gzipSync(Buffer.from(JSON.stringify({ Name: "Trailing Tom" }))), Buffer.from("garbage-after-the-stream")]);
    const res = await request(app)
      .post(`/api/public/${SLUG}/submit`)
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .send(body)
      .timeout({ response: 8000, deadline: 12000 });
    expect([200, 400, 413, 415]).toContain(res.status);
  }, 20000);

  it("a JSON body on an authenticated route is parsed (validation answers, it does not fail to read the body)", async () => {
    const res = await request(app).post("/api/forms").set("Authorization", `Bearer ${token}`).send({ title: "" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe("multipart uploads (multer)", () => {
  it("an image upload is stored, answered with its URL, and served back byte for byte", async () => {
    const res = await request(app).post("/api/upload?type=branding").set("Authorization", `Bearer ${token}`).attach("file", PNG, { filename: "dot.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.url).toContain("/api/upload/file/");
    expect(res.body.metadata.size).toBe(PNG.length);
    const served = await request(app)
      .get(new URL(res.body.url).pathname)
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(served.status).toBe(200);
    expect(Buffer.compare(served.body as Buffer, PNG)).toBe(0);
  });

  it("a file of the wrong type is refused and leaves nothing on disk", async () => {
    const before = fs.readdirSync(uploadDir).length;
    const res = await request(app).post("/api/upload?type=branding").set("Authorization", `Bearer ${token}`).attach("file", Buffer.from("not an image"), "note.txt");
    expect(res.status).toBe(400);
    expect(fs.readdirSync(uploadDir).filter((f) => f.endsWith(".txt")).length).toBe(0);
    expect(fs.readdirSync(uploadDir).length).toBe(before);
  });

  it("a multipart public submit (the `data` field) is parsed and stored", async () => {
    const res = await request(app)
      .post(`/api/public/${SLUG}/submit`)
      .field("data", JSON.stringify({ answers: [{ fieldId: "f1", value: "Multipart Mia" }] }));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await stored())).toContain("Multipart Mia");
  });

  it("an upload without a token is refused before the file is read", async () => {
    const res = await request(app).post("/api/upload?type=branding").attach("file", PNG, { filename: "dot.png", contentType: "image/png" });
    expect(res.status).toBe(401);
  });
});
