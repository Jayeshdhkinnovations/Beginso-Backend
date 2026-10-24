// End-to-end: the CSV has one column per question and the download has a readable name; the PDF still builds.
process.env.JWT_SECRET = "test-jwt-secret-key-for-report-export-files";
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
let alice: any;
const personal = (u: any) => ({ Authorization: `Bearer ${generateToken({ id: u._id.toString(), email: u.email, role: "user" })}`, "x-workspace-slug": "personal" });

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  alice = await User.create({ firebaseUid: "uid-ref-alice", fullName: "alice", email: "alice@ref.test", status: "active" });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const fetchReport = async (body: any) => {
  const created = await request(app).post("/api/reports").set(personal(alice)).send(body);
  expect(created.status).toBe(202);
  const id = created.body.report.id;
  for (let i = 0; i < 200; i++) {
    const r = await request(app).get(`/api/reports/${id}`).set(personal(alice));
    if (r.body.report?.status === "completed") break;
    await new Promise((res) => setTimeout(res, 50));
  }
  return request(app).get(`/api/reports/${id}/file`).set(personal(alice)).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
};

describe("report files", () => {
  it("CSV: a 3-question form gives 3 question columns, BOM, readable status and filename; injection is neutralised", async () => {
    const form = await Form.create({
      title: "Customer Feedback", workspaceId: null, createdBy: alice._id, status: "published",
      fields: [
        { fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: false },
        { fieldId: "f2", pageId: "p1", label: "Colours", type: "checkbox", required: false, options: ["red", "blue"] },
        { fieldId: "f3", pageId: "p1", label: "Score", type: "number", required: false },
      ],
      pages: [{ id: "p1", order: 0, title: "P" }],
    } as any);
    await ResponseModel.create([
      { formId: form._id, answers: { Name: "=cmd|' /C calc'!A0", Colours: ["red", "blue"], Score: "-5", Stray: "kept" } },
      { formId: form._id, answers: { f1: "Asha", f3: 7 }, status: "completed" },
    ]);

    const res = await fetchReport({ format: "csv", formId: String(form._id) });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/filename="beginso-customer-feedback-\d{4}-\d{2}-\d{2}\.csv"/);
    const csv = (res.body as Buffer).toString("utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const header = csv.slice(1).split("\n")[0];
    expect(header).toBe('"Response ID","Reference","Form ID","Form Title","Status","Submitted At","Score Average","Score Count","Name","Colours","Score","Other answers"');
    expect(csv).toContain(`"'=cmd|' /C calc'!A0"`);
    expect(csv).toContain('"red; blue","-5"');
    expect(csv).toContain('"Stray: kept"');
    expect(csv).toContain('"Completed"');
    expect(csv).toContain('"New"');
    expect(csv).toContain('"Asha"');
  });

  it("PDF: builds with a question breakdown for a single form", async () => {
    const form = await Form.create({
      title: "Poll", workspaceId: null, createdBy: alice._id, status: "published",
      fields: [{ fieldId: "q1", pageId: "p1", label: "Pick one", type: "dropdown", required: false, options: ["A", "B"] }],
      pages: [{ id: "p1", order: 0, title: "P" }],
    } as any);
    await ResponseModel.create([{ formId: form._id, answers: { "Pick one": "A" } }, { formId: form._id, answers: { "Pick one": "A" } }, { formId: form._id, answers: { "Pick one": "B" } }]);
    const res = await fetchReport({ format: "pdf", formId: String(form._id) });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    expect(res.headers["content-disposition"]).toMatch(/beginso-poll-.*\.pdf/);
  });

  it("PDF: a small all-forms report is one page (no trailing blank pages)", async () => {
    const res = await fetchReport({ format: "pdf" });
    expect(res.status).toBe(200);
    const pages = (res.body as Buffer).toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? [];
    expect(pages).toHaveLength(1);
  });
  describe("PDF of chosen responses", () => {
    const pageCount = (res: any) => ((res.body as Buffer).toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
    let form: any;
    let rows: any[];
    beforeAll(async () => {
      form = await Form.create({
        title: "Film submissions", workspaceId: null, createdBy: alice._id, status: "published",
        fields: [
          { fieldId: "a1", pageId: "p1", label: "Name", type: "short_text", required: true },
          { fieldId: "a2", pageId: "p1", label: "Genres", type: "checkbox", required: false, options: ["Drama", "Comedy"] },
          { fieldId: "a3", pageId: "p2", label: "Synopsis", type: "long_text", required: false },
          { fieldId: "a4", pageId: "p2", label: "Skipped question", type: "short_text", required: false },
        ],
        pages: [{ id: "p1", order: 0, title: "About you" }, { id: "p2", order: 1, title: "The film" }],
      } as any);
      rows = await ResponseModel.create([
        { formId: form._id, answers: { Name: "Asha", Genres: ["Drama", "Comedy"], Synopsis: "A short one." }, respondentEmail: "asha@x.test" },
        { formId: form._id, answers: { Name: "Ben" }, respondentEmail: "ben@x.test" },
        { formId: form._id, answers: { Name: "Chitra", Synopsis: "Long. ".repeat(4000) }, respondentEmail: "chitra@x.test" },
      ]);
    });

    it("only the selected response is in the file: one response, one page, the response document and not the analytics report", async () => {
      const res = await fetchReport({ format: "pdf", ids: [String(rows[0]._id)] });
      expect(res.status).toBe(200);
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
      expect(pageCount(res)).toBe(1);
    });

    it("each selected response starts on its own page", async () => {
      const res = await fetchReport({ format: "pdf", ids: [String(rows[0]._id), String(rows[1]._id)] });
      expect(pageCount(res)).toBe(2);
    });

    it("a very long answer runs on to more pages instead of being cut off", async () => {
      const res = await fetchReport({ format: "pdf", ids: [String(rows[2]._id)] });
      expect(pageCount(res)).toBeGreaterThan(2);
    });

    it("an id that is not found gives a readable one-page file, not a failed report", async () => {
      const res = await fetchReport({ format: "pdf", ids: [String(new mongoose.Types.ObjectId())] });
      expect(res.status).toBe(200);
      expect(pageCount(res)).toBe(1);
    });
  });
});
