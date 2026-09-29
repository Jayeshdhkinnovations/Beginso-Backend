import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import FormReferenceCounter from "../models/FormReferenceCounter";
import { generateToken } from "../utils/generateToken";
import { allocateReference } from "../services/reference.service";
import { backfillResponseReference } from "../scripts/backfillResponseReference";
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
    expect(r1).toBe("#1");
    expect(r2).toBe("#2");
    expect(r3).toBe("#3");
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

  it("is independent per form: two forms both start at #1", async () => {
    const formC = await Form.create({
      title: "Form C",
      workspaceId,
      status: "published",
      publishedSlug: "form-c-slug",
      fields: [],
    });
    const formDId = (formC._id as mongoose.Types.ObjectId).toString();
    const r = await allocateReference(formDId);
    expect(r).toBe("#1");
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
    expect(refs.every((r) => typeof r === "string" && /^#\d+$/.test(r as string))).toBe(true);
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
    expect(next).toBe("#4");
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
