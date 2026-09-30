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

// Sprint 12, BE 0.6 (B4.10/B8.3) regression coverage. duplicate.service.ts's extractRespondentEmail
// / findDuplicateOf and their wiring into form.service.ts's createResponse are already correct and
// stable (Friday's work) — this is the "separate, later test pass" for them, not new behavior.

let mongoServer: MongoMemoryServer;
let ownerToken: string;
let ownerId: string;
let workspaceId: string;
let formWithEmailId: string;
let formWithEmailSlug: string;
let formNoEmailId: string;
let formNoEmailSlug: string;
let secondFormWithEmailId: string;
let secondFormWithEmailSlug: string;

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const owner = await User.create({ firebaseUid: "dup-owner-uid", fullName: "Owner", email: "dup-owner@test.com", role: "admin" });
  ownerId = owner._id.toString();
  const ws = await Workspace.create({ name: "Duplicate Workspace", owner: owner._id });
  workspaceId = (ws._id as mongoose.Types.ObjectId).toString();
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  ownerToken = generateToken({ id: ownerId, email: owner.email, role: owner.role });

  const formWithEmail = await Form.create({
    title: "Form With Email",
    workspaceId: ws._id,
    status: "published",
    publishedSlug: "dup-form-with-email",
    fields: [{ fieldId: "email1", label: "Your Email", type: "email", required: true }],
  });
  formWithEmailId = (formWithEmail._id as mongoose.Types.ObjectId).toString();
  formWithEmailSlug = formWithEmail.publishedSlug as string;

  const secondFormWithEmail = await Form.create({
    title: "Second Form With Email",
    workspaceId: ws._id,
    status: "published",
    publishedSlug: "dup-second-form-with-email",
    fields: [{ fieldId: "email1", label: "Your Email", type: "email", required: true }],
  });
  secondFormWithEmailId = (secondFormWithEmail._id as mongoose.Types.ObjectId).toString();
  secondFormWithEmailSlug = secondFormWithEmail.publishedSlug as string;

  const formNoEmail = await Form.create({
    title: "Form No Email",
    workspaceId: ws._id,
    status: "published",
    publishedSlug: "dup-form-no-email",
    fields: [{ fieldId: "name1", label: "Your Name", type: "short_text", required: false }],
  });
  formNoEmailId = (formNoEmail._id as mongoose.Types.ObjectId).toString();
  formNoEmailSlug = formNoEmail.publishedSlug as string;
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

const submit = (slug: string, answers: Record<string, any>) =>
  request(app).post(`/api/public/${slug}/submit`).field("data", JSON.stringify(answers));

describe("Duplicate detection (B4.10/B8.3)", () => {
  it("the earliest response to a form is never flagged", async () => {
    const res = await submit(formWithEmailSlug, { "Your Email": "first@test.com" });
    expect(res.status).toBe(200);
    const stored = await ResponseModel.findOne({ formId: formWithEmailId, respondentEmail: "first@test.com" });
    expect(stored!.duplicateOfId).toBeNull();
  });

  it("a later same-email (case-insensitive) submission to the SAME form is flagged with the correct duplicateOfId", async () => {
    const earlier = await submit(formWithEmailSlug, { "Your Email": "repeat@test.com" });
    const earlierResp = await ResponseModel.findOne({ formId: formWithEmailId, respondentEmail: "repeat@test.com" });
    expect(earlierResp!.duplicateOfId).toBeNull();

    const later = await submit(formWithEmailSlug, { "Your Email": "REPEAT@Test.com" });
    expect(later.status).toBe(200);
    const laterResp = await ResponseModel.findOne({
      formId: formWithEmailId,
      respondentEmail: "repeat@test.com",
      _id: { $ne: earlierResp!._id },
    });
    expect(laterResp).not.toBeNull();
    expect(laterResp!.duplicateOfId?.toString()).toBe(earlierResp!._id.toString());
  });

  it("a same-email submission to a DIFFERENT form is not flagged", async () => {
    await submit(formWithEmailSlug, { "Your Email": "cross-form@test.com" });
    const other = await submit(secondFormWithEmailSlug, { "Your Email": "cross-form@test.com" });
    expect(other.status).toBe(200);

    const otherStored = await ResponseModel.findOne({ formId: secondFormWithEmailId, respondentEmail: "cross-form@test.com" });
    expect(otherStored!.duplicateOfId).toBeNull();
  });

  it("a submission with no email answer gets duplicateOfId: null, not a crash", async () => {
    const res = await submit(formNoEmailSlug, { "Your Name": "Anon" });
    expect(res.status).toBe(200);
    const stored = await ResponseModel.findOne({ formId: formNoEmailId });
    expect(stored!.duplicateOfId).toBeNull();
    expect(stored!.respondentEmail).toBeNull();
  });

  it("exposes duplicateOfId on the response detail and list, filterable via ?duplicate=true", async () => {
    const earlier = await submit(formWithEmailSlug, { "Your Email": "listed@test.com" });
    const earlierId = (await ResponseModel.findOne({ formId: formWithEmailId, respondentEmail: "listed@test.com" }))!._id.toString();
    await submit(formWithEmailSlug, { "Your Email": "listed@test.com" });

    const detail = await request(app)
      .get(`/api/responses/${earlierId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(detail.body.response.duplicateOfId).toBeNull();

    const list = await request(app)
      .get(`/api/responses?formId=${formWithEmailId}&duplicate=true`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    for (const row of list.body.data) {
      expect(row.duplicateOfId).not.toBeNull();
    }
  });
});
