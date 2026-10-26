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
import { allocateReference } from "../services/reference.service";
import { backfillResponseReference } from "../scripts/backfillResponseReference";
import { backfillReferenceFormat } from "../scripts/backfillReferenceFormat";
import { codeFrom, formatReference, nextCode } from "../services/reference.service";
import { generateReportAsync } from "../services/report.service";
import ReportModel from "../models/Report";
import fs from "fs";

let mongoServer: MongoMemoryServer;
let ownerToken: string;
let ownerId: string;
let workspaceId: string;
let formId: string;
let formBId: string;

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const owner = await User.create({ firebaseUid: "ref-owner-uid", fullName: "Owner", email: "ref-owner@test.com", role: "admin" });
  ownerId = owner._id.toString();
  const ws = await Workspace.create({ name: "Reference Workspace", owner: owner._id });
  workspaceId = (ws._id as mongoose.Types.ObjectId).toString();
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });

  const form = await Form.create({
    title: "Reference Form",
    workspaceId: ws._id,
    status: "published",
    publishedSlug: "reference-form-slug",
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
  });
  formId = (form._id as mongoose.Types.ObjectId).toString();

  const formB = await Form.create({
    title: "Reference Form B",
    workspaceId: ws._id,
    status: "published",
    publishedSlug: "reference-form-b-slug",
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
  });
  formBId = (formB._id as mongoose.Types.ObjectId).toString();

  ownerToken = generateToken({ id: ownerId, email: owner.email, role: owner.role });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe("Response reference allocation (B8.1)", () => {
  it("is sequential per form starting at 1", async () => {
    const r1 = await allocateReference(formId);
    const r2 = await allocateReference(formId);
    const r3 = await allocateReference(formId);
    expect(r1).toBe("REFREF0001");
    expect(r2).toBe("REFREF0002");
    expect(r3).toBe("REFREF0003");
  });

  it("is race-safe: N concurrent allocations for the same form never collide", async () => {
    const form = await Form.create({
      title: "Concurrent Form",
      workspaceId,
      status: "published",
      publishedSlug: "concurrent-form-slug",
      fields: [],
    });
    const concurrentFormId = (form._id as mongoose.Types.ObjectId).toString();

    const results = await Promise.all(Array.from({ length: 25 }, () => allocateReference(concurrentFormId)));
    const unique = new Set(results);
    expect(unique.size).toBe(25);
  });

  it("is independent per form: another form starts at 0001 and its own letters", async () => {
    const formC = await Form.create({
      title: "Form C",
      workspaceId,
      status: "published",
      publishedSlug: "form-c-slug",
      fields: [],
    });
    const formDId = (formC._id as mongoose.Types.ObjectId).toString();
    const r = await allocateReference(formDId);
    expect(r).toBe("REFFOR0001");
  });

  it("real concurrent submissions to the same form never receive the same reference", async () => {
    const form = await Form.create({
      title: "Submit Concurrency Form",
      workspaceId,
      status: "published",
      publishedSlug: "submit-concurrency-slug",
      fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
    });

    const submissions = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).post(`/api/public/${form.publishedSlug}/submit`).send({ Name: "x" })
      )
    );
    submissions.forEach((r) => expect(r.status).toBe(200));

    const responses = await ResponseModel.find({ formId: form._id }).select("reference").lean();
    const refs = responses.map((r) => r.reference);
    expect(refs.length).toBe(10);
    expect(new Set(refs).size).toBe(10);
    expect(refs.every((r) => typeof r === "string" && /^REFSUB\d{4}$/.test(r as string))).toBe(true);
  });

  it("is included in the list, detail and CSV export payloads", async () => {
    const resp = await ResponseModel.create({ formId, answers: { Name: "Alice" }, reference: "#7" });

    const listRes = await request(app).get(`/api/responses?formId=${formId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.status).toBe(200);
    const found = listRes.body.data.find((r: any) => r._id === resp._id.toString());
    expect(found.reference).toBe("#7");

    const detailRes = await request(app).get(`/api/responses/${resp._id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.response.reference).toBe("#7");
  });
});

describe("Reference back-fill migration", () => {
  it("back-fills per form in submittedAt order, starting from 1, and is idempotent", async () => {
    const form = await Form.create({
      title: "Backfill Form",
      workspaceId,
      status: "published",
      publishedSlug: "backfill-form-slug",
      fields: [],
    });
    const bfFormId = (form._id as mongoose.Types.ObjectId).toString();

    const t0 = new Date("2026-01-01T00:00:00Z");
    const r1 = await ResponseModel.create({ formId: bfFormId, answers: {}, submittedAt: new Date(t0.getTime() + 3000) });
    const r2 = await ResponseModel.create({ formId: bfFormId, answers: {}, submittedAt: new Date(t0.getTime() + 1000) });
    const r3 = await ResponseModel.create({ formId: bfFormId, answers: {}, submittedAt: new Date(t0.getTime() + 2000) });

    const result = await backfillResponseReference();
    expect(result.responsesBackfilled).toBeGreaterThanOrEqual(3);

    const after1 = await ResponseModel.findById(r1._id).select("reference").lean();
    const after2 = await ResponseModel.findById(r2._id).select("reference").lean();
    const after3 = await ResponseModel.findById(r3._id).select("reference").lean();

    // submittedAt order: r2 (t0+1s) < r3 (t0+2s) < r1 (t0+3s)
    expect(after2!.reference).toBe("#1");
    expect(after3!.reference).toBe("#2");
    expect(after1!.reference).toBe("#3");
    // (the first back-fill gives the old "#n" form; backfillReferenceFormat then moves it to the new one, below)

    // Idempotent: re-running does not change already-assigned references or duplicate them.
    const secondRun = await backfillResponseReference();
    const stillAfter1 = await ResponseModel.findById(r1._id).select("reference").lean();
    const stillAfter2 = await ResponseModel.findById(r2._id).select("reference").lean();
    const stillAfter3 = await ResponseModel.findById(r3._id).select("reference").lean();
    expect(stillAfter1!.reference).toBe(after1!.reference);
    expect(stillAfter2!.reference).toBe(after2!.reference);
    expect(stillAfter3!.reference).toBe(after3!.reference);
    expect(secondRun.responsesBackfilled).toBe(0);

    // Live allocation after backfill continues past the backfilled sequence rather than colliding.
    const next = await allocateReference(bfFormId);
    expect(next).toBe("REFBAC0004"); // the counter carries on past the back-filled numbers, now in the new form
  });

  it("skips responses that already have a reference", async () => {
    const form = await Form.create({
      title: "Partial Backfill Form",
      workspaceId,
      status: "published",
      publishedSlug: "partial-backfill-slug",
      fields: [],
    });
    const pFormId = (form._id as mongoose.Types.ObjectId).toString();

    const already = await ResponseModel.create({ formId: pFormId, answers: {}, reference: "#99" });
    const unref = await ResponseModel.create({ formId: pFormId, answers: {} });

    await backfillResponseReference();

    const stillAlready = await ResponseModel.findById(already._id).select("reference").lean();
    const nowRef = await ResponseModel.findById(unref._id).select("reference").lean();
    expect(stillAlready!.reference).toBe("#99");
    expect(nowRef!.reference).toBeTruthy();
    expect(nowRef!.reference).not.toBe("#99");
  });
});

describe("CSV export includes reference", () => {
  it("writes a Reference column populated from the response's reference", async () => {
    const resp = await ResponseModel.create({ formId: formBId, answers: { Name: "Bob" }, reference: "#55" });

    const report = await ReportModel.create({
      workspaceId,
      requestedBy: ownerId,
      format: "csv",
      status: "queued",
      filters: { formId: formBId },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await generateReportAsync(report._id.toString());
    const refreshed = await ReportModel.findById(report._id);
    expect(refreshed!.status).toBe("completed");

    const csv = fs.readFileSync(refreshed!.filePath as string, "utf8");
    expect(csv.split("\n")[0]).toContain("Reference");
    expect(csv).toContain(`"${resp._id.toString()}","#55"`);
  });
});

describe("Reference format: workspace letters, form letters, number", () => {
  it("builds the letters from the names: upper-case, accents, digits and symbols dropped, short names padded", () => {
    expect(codeFrom("Kala Chasma")).toBe("KAL");
    expect(codeFrom("Ünïcode form")).toBe("UNI");
    expect(codeFrom("  2024 Poll")).toBe("POL");
    expect(codeFrom("A")).toBe("AXX");
    expect(codeFrom("")).toBe("XXX");
    expect(formatReference("KAL", "CUS", 42)).toBe("KALCUS0042");
    expect(formatReference("KAL", "CUS", 12345)).toBe("KALCUS12345");
    expect(nextCode("CUS")).toBe("CUT");
    expect(nextCode("CUZ")).toBe("CVA");
    expect(nextCode("ZZZ")).toBe("AAA");
  });

  it("two forms of one workspace that start with the same letters still get different references", async () => {
    const a = await Form.create({ title: "Customer service", workspaceId, status: "published", fields: [] });
    const b = await Form.create({ title: "Customer survey", workspaceId, status: "published", fields: [] });
    const c = await Form.create({ title: "Customer care", workspaceId, status: "published", fields: [] });
    const refs = [await allocateReference(a._id as any), await allocateReference(b._id as any), await allocateReference(c._id as any)];
    expect(refs).toEqual(["REFCUS0001", "REFCUT0001", "REFCUU0001"]);
  });

  it("two workspaces that start with the same letters get different workspace letters", async () => {
    const owner = await User.create({ firebaseUid: "ref-owner-2", fullName: "O2", email: "ref-owner-2@test.com", role: "admin" });
    const ws2 = await Workspace.create({ name: "Reference Studio", owner: owner._id });
    const f = await Form.create({ title: "Poll", workspaceId: ws2._id, status: "published", fields: [] });
    expect(await allocateReference(f._id as any)).toBe("REGPOL0001");
  });

  it("the letters are fixed by the first response: renaming the form later changes nothing", async () => {
    const f = await Form.create({ title: "Alpha", workspaceId, status: "published", fields: [] });
    expect(await allocateReference(f._id as any)).toBe("REFALP0001");
    await Form.updateOne({ _id: f._id }, { $set: { title: "Zebra" } });
    expect(await allocateReference(f._id as any)).toBe("REFALP0002");
  });

  it("a deleted response leaves its number unused: the next response does not take it", async () => {
    const f = await Form.create({ title: "Gaps", workspaceId, status: "published", fields: [] });
    const first = await allocateReference(f._id as any);
    const second = await allocateReference(f._id as any);
    const r = await ResponseModel.create({ formId: f._id, answers: {}, reference: second });
    await ResponseModel.deleteOne({ _id: r._id });
    expect([first, second]).toEqual(["REFGAP0001", "REFGAP0002"]);
    expect(await allocateReference(f._id as any)).toBe("REFGAP0003");
  });

  it("a personal form (no workspace) uses MY", async () => {
    const f = await Form.create({ title: "Mine", workspaceId: null, status: "published", fields: [] });
    expect(await allocateReference(f._id as any)).toBe("MYMIN0001");
  });

  it("concurrent first responses to a new form agree on one set of letters", async () => {
    const f = await Form.create({ title: "Race", workspaceId, status: "published", fields: [] });
    const refs = await Promise.all(Array.from({ length: 12 }, () => allocateReference(f._id as any)));
    expect(new Set(refs).size).toBe(12);
    expect(refs.every((r) => r.startsWith("REFRAC"))).toBe(true);
  });
});

describe("Converting the old #n references", () => {
  it("keeps the number, keeps the old text searchable, skips new-style ones, and is idempotent", async () => {
    const f = await Form.create({ title: "Legacy", workspaceId, status: "published", fields: [] });
    const old1 = await ResponseModel.create({ formId: f._id, answers: {}, reference: "#7" });
    const old2 = await ResponseModel.create({ formId: f._id, answers: {}, reference: "#12" });
    const fresh = await ResponseModel.create({ formId: f._id, answers: {}, reference: "REFOTH0003" });
    const first = await backfillReferenceFormat();
    expect(first.responsesConverted).toBeGreaterThanOrEqual(2);
    expect((await ResponseModel.findById(old1._id).lean())!.reference).toBe("REFLEG0007");
    expect((await ResponseModel.findById(old1._id).lean())!.legacyReference).toBe("#7");
    expect((await ResponseModel.findById(old2._id).lean())!.reference).toBe("REFLEG0012");
    expect((await ResponseModel.findById(fresh._id).lean())!.reference).toBe("REFOTH0003");
    const second = await backfillReferenceFormat();
    expect(second.responsesConverted).toBe(0);
  });
});
