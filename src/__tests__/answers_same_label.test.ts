// QA D5-001 (high, data loss): two questions with the same label shared one stored answer, so the first was lost.
// Each question now has its own storage key ("Comment", "Comment (2)"), and the response list, CSV export,
// analytics and logic all read it back per question.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { clearRateLimitStore } from "../middleware/rateLimiter";
import { generateToken } from "../utils/generateToken";
import { buildAnswerKeyMap, readFieldAnswer, activeAnswerKeys } from "../utils/answerKeys";
import { normaliseSubmittedAnswers } from "../utils/answers";

process.env.JWT_SECRET = "test-jwt-secret-key-for-answers-same-label";

let mongo: MongoMemoryServer;
let owner: any, ws: any, form: any, token: string;

const fields: any[] = [
  { fieldId: "f-a", pageId: "p1", label: "Comment", type: "short_text", required: false },
  { fieldId: "f-b", pageId: "p1", label: "Comment", type: "short_text", required: false },
  { fieldId: "f-c", pageId: "p1", label: "Comment (2)", type: "short_text", required: false }, // a real label that collides with the suffix
  { fieldId: "f-d", pageId: "p1", label: "Plan", type: "dropdown", required: false, options: ["Free", "Pro"] },
];

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  owner = await User.create({ firebaseUid: "uid-asl-owner", fullName: "Owner", email: "asl-owner@test.com", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "ASL WS", slug: "asl-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  token = generateToken({ id: owner._id.toString(), email: owner.email, role: "user" });
  form = await Form.create({
    title: "Dup labels", workspaceId: ws._id, createdBy: owner._id, status: "published", slug: "asl-1", publishedSlug: "asl-1",
    fields, pages: [{ id: "p1", order: 0, title: "P" }],
  });
});
beforeEach(() => clearRateLimitStore());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("answer keys", () => {
  it("the first question keeps its label; repeats get (2), (3), never colliding with a real label", () => {
    const map = buildAnswerKeyMap(fields as any);
    expect(fields.map((f) => map.get(f as any))).toEqual(["Comment", "Comment (3)", "Comment (2)", "Plan"]);
  });

  it("a form without repeated labels maps every question to its own label (old data keeps working)", () => {
    const f = [{ label: "A" }, { label: "B" }];
    expect(f.map((x) => buildAnswerKeyMap(f).get(x))).toEqual(["A", "B"]);
  });

  it("a deleted question never takes a label away from an active one", () => {
    const f = [{ label: "Comment", deleted: true }, { label: "Comment" }];
    const map = buildAnswerKeyMap(f);
    expect(map.get(f[1])).toBe("Comment");
    expect([...activeAnswerKeys(f, map)]).toEqual(["Comment"]);
  });

  it("a repeated question does not borrow the first one's value from the plain label", () => {
    const map = buildAnswerKeyMap(fields as any);
    const answers = { Comment: "first" };
    expect(readFieldAnswer(answers, fields[0] as any, map)).toBe("first");
    expect(readFieldAnswer(answers, fields[1] as any, map)).toBeUndefined();
  });

  it("a test submission (JSON by field id) keeps both answers", () => {
    const out = normaliseSubmittedAnswers(form.toObject(), { "f-a": "one", "f-b": "two", "f-c": "three" });
    expect(out).toEqual({ Comment: "one", "Comment (3)": "two", "Comment (2)": "three" });
  });
});

describe("public submit", () => {
  const submit = (body: any) => request(app).post("/api/public/asl-1/submit").send(body);

  it("stores both answers when the client sends them by field id", async () => {
    const res = await submit({ "f-a": "first", "f-b": "second", "f-c": "third", "f-d": "Pro" });
    expect(res.status).toBe(200);
    const stored: any = await ResponseModel.findOne({ formId: form._id }).sort({ createdAt: -1 }).lean();
    expect(stored.answers).toEqual({ Comment: "first", "Comment (3)": "second", "Comment (2)": "third", Plan: "Pro" });
  });

  it("stores both answers when the client sends the array shape (fieldId + label)", async () => {
    await ResponseModel.deleteMany({ formId: form._id });
    const res = await submit({
      answers: [
        { fieldId: "f-a", label: "Comment", value: "alpha" },
        { fieldId: "f-b", label: "Comment", value: "beta" },
      ],
    });
    expect(res.status).toBe(200);
    const stored: any = await ResponseModel.findOne({ formId: form._id }).lean();
    expect(stored.answers.Comment).toBe("alpha");
    expect(stored.answers["Comment (3)"]).toBe("beta");
  });

  it("an unknown key is still dropped", async () => {
    await ResponseModel.deleteMany({ formId: form._id });
    await submit({ "f-a": "x", "$where": "1", nope: "y" });
    const stored: any = await ResponseModel.findOne({ formId: form._id }).lean();
    expect(Object.keys(stored.answers)).toEqual(["Comment"]);
  });
});

describe("readers", () => {
  const auth = { Authorization: `Bearer ${"" as string}`, "x-workspace-slug": "asl-ws" };
  beforeAll(async () => {
    await ResponseModel.deleteMany({ formId: form._id });
    await ResponseModel.create([
      { formId: form._id, answers: { Comment: "first-1", "Comment (3)": "second-1", Plan: "Pro" }, status: "new" },
      { formId: form._id, answers: { Comment: "first-2", "Comment (3)": "second-2", Plan: "Free" }, status: "new" },
    ]);
    auth.Authorization = `Bearer ${token}`;
  });

  it("the response list returns both answers", async () => {
    const res = await request(app).get(`/api/responses?formId=${form._id}`).set(auth);
    expect(res.status).toBe(200);
    const answers = (res.body.data ?? res.body.responses).map((r: any) => r.answers);
    expect(answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ Comment: "first-1", "Comment (3)": "second-1" }),
      expect.objectContaining({ Comment: "first-2", "Comment (3)": "second-2" }),
    ]));
  });

  it("the CSV has one column per question with each question's own answer", async () => {
    const created = await request(app).post("/api/reports").set(auth).send({ format: "csv", formId: String(form._id) });
    expect(created.status).toBe(202);
    const id = created.body.report.id;
    for (let i = 0; i < 100; i++) {
      const r = await request(app).get(`/api/reports/${id}`).set(auth);
      if (r.body.report?.status === "completed") break;
      await new Promise((r2) => setTimeout(r2, 50));
    }
    const file = await request(app).get(`/api/reports/${id}/file`).set(auth).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    const csv = (file.body as Buffer).toString("utf8");
    const [header, ...rows] = csv.slice(1).trim().split("\n");
    const cols = header.split(",").map((c) => c.replace(/^"|"$/g, ""));
    const iFirst = cols.indexOf("Comment");
    const iSecond = cols.indexOf("Comment (3)");
    expect(iFirst).toBeGreaterThan(-1);
    expect(iSecond).toBeGreaterThan(-1);
    const row = rows.map((r) => r.split(",").map((c) => c.replace(/^"|"$/g, ""))).find((c) => c[iFirst] === "first-1")!;
    expect(row[iSecond]).toBe("second-1");
  });

  it("analytics reports each repeated question separately", async () => {
    const res = await request(app).get(`/api/analytics/questions?formId=${form._id}`).set(auth);
    expect(res.status).toBe(200);
    const qs = res.body.data.questions as any[];
    const a = qs.find((q) => q.fieldId === "f-a");
    const b = qs.find((q) => q.fieldId === "f-b");
    expect(a.summary.text.sampleAnswers).toEqual(expect.arrayContaining(["first-1", "first-2"]));
    expect(b.summary.text.sampleAnswers).toEqual(expect.arrayContaining(["second-1", "second-2"]));
    expect(b.summary.text.sampleAnswers).not.toContain("first-1");
  });
});
