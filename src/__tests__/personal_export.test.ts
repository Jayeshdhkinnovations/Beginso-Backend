// Personal-space exports: a user with no workspace in play can create, poll and download an export of their own
// forms, and it never carries another user's personal data.
process.env.JWT_SECRET = "test-jwt-secret-key-for-personal-export";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { generateToken } from "../utils/generateToken";

let mongo: MongoMemoryServer;
let alice: any, bob: any;
const personal = (u: any) => ({ Authorization: `Bearer ${generateToken({ id: u._id.toString(), email: u.email, role: "user" })}`, "x-workspace-slug": "personal" });
const mkForm = (owner: any, title: string) =>
  Form.create({
    title, workspaceId: null, createdBy: owner._id, status: "published",
    fields: [{ fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: false }],
    pages: [{ id: "p1", order: 0, title: "Page" }],
  } as any);

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  [alice, bob] = await Promise.all(["alice", "bob"].map((n) => User.create({ firebaseUid: `uid-pe-${n}`, fullName: n, email: `${n}@pe.test`, status: "active" })));
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const download = async (u: any, id: string) => {
  for (let i = 0; i < 200; i++) {
    const r = await request(app).get(`/api/reports/${id}`).set(personal(u));
    if (r.body.report?.status === "completed") break;
    await new Promise((res) => setTimeout(res, 50));
  }
  return request(app).get(`/api/reports/${id}/file`).set(personal(u)).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
};

describe("personal-space export", () => {
  it("creates, completes and downloads an export of the caller's own responses only", async () => {
    const mine = await mkForm(alice, "Alice form");
    const theirs = await mkForm(bob, "Bob form");
    await ResponseModel.create([{ formId: mine._id, answers: { Name: "alice-answer-1" } }, { formId: theirs._id, answers: { Name: "bob-secret-answer" } }]);

    const created = await request(app).post("/api/reports").set(personal(alice)).send({ format: "csv" });
    expect(created.status).toBe(202);
    expect(created.body.report.workspaceId).toBeNull();

    const file = await download(alice, created.body.report.id);
    expect(file.status).toBe(200);
    const csv = (file.body as Buffer).toString("utf8");
    expect(csv).toContain("alice-answer-1");
    expect(csv).not.toContain("bob-secret-answer");
    expect(csv).not.toContain("Bob form");
  });

  it("another user cannot read or download it", async () => {
    const created = await request(app).post("/api/reports").set(personal(alice)).send({ format: "csv" });
    expect((await request(app).get(`/api/reports/${created.body.report.id}`).set(personal(bob))).status).toBe(404);
    expect((await request(app).get(`/api/reports/${created.body.report.id}/file`).set(personal(bob))).status).toBe(404);
  });

  it("a personal export of someone else's form is refused", async () => {
    const theirs = await mkForm(bob, "Bob form 2");
    const res = await request(app).post("/api/reports").set(personal(alice)).send({ format: "csv", formId: String(theirs._id) });
    expect(res.status).toBe(404);
  });
});
