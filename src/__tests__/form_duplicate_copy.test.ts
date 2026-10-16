// QA A4b-001: Duplicate copied only the title, description and fields. The copy lost its pages (so every page title and
// the page each field sits on), its branding and its settings (including the access mode).
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-form-duplicate-copy";

let mongoServer: MongoMemoryServer;
let owner: any;
let ws: any;

const duplicate = (formId: string, scope: "ws" | "personal" = "ws") => {
  const r = request(app)
    .post(`/api/forms/${formId}/duplicate`)
    .set("Authorization", `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role })}`);
  return scope === "ws" ? r.set("x-workspace-id", ws._id.toString()) : r.set("x-workspace-slug", "personal");
};

const original = (extra: any = {}) =>
  Form.create({
    title: "Customer survey",
    description: "Tell us",
    workspaceId: ws._id,
    createdBy: owner._id,
    status: "published",
    slug: `orig-${Math.random().toString(36).slice(2, 8)}`,
    publishedSlug: `pub-${Math.random().toString(36).slice(2, 8)}`,
    pages: [
      { id: "page-a", order: 0, title: "About you", description: "A few details" },
      { id: "page-b", order: 1, title: "Your feedback" },
    ],
    fields: [
      { fieldId: "f1", pageId: "page-a", label: "Name", type: "short_text", required: true },
      { fieldId: "f2", pageId: "page-b", label: "Comments", type: "long_text", required: false },
    ],
    branding: { primaryColor: "#DC2626", logoUrl: "https://cdn.example/logo.png", coverImageUrl: "https://cdn.example/cover.png", fontFamily: "lora", cardStyle: "bordered", formWidth: "narrow" },
    settings: { accessMode: "tracked", successMessage: "Thanks!", responseLimitEnabled: true, responseLimit: 50, closeDate: "2020-01-01T00:00:00.000Z", honeypotEnabled: true },
    ...extra,
  });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  owner = await User.create({ firebaseUid: "uid-dup-owner", fullName: "Dup Owner", email: "dup-owner@test.com", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "Dup WS", slug: "dup-ws", timezone: "UTC", owner: owner._id });
  owner.workspaceId = ws._id;
  await owner.save();
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("POST /api/forms/:id/duplicate keeps what makes the form what it is", () => {
  it("copies pages, branding and settings (including the access mode)", async () => {
    const src: any = await original();
    const res = await duplicate(src._id.toString());
    expect(res.status).toBe(201);
    const copy: any = await Form.findById(res.body.form._id).lean();
    const orig: any = await Form.findById(src._id).lean();

    expect(copy.pages.map((p: any) => ({ id: p.id, order: p.order, title: p.title, description: p.description }))).toEqual(
      orig.pages.map((p: any) => ({ id: p.id, order: p.order, title: p.title, description: p.description }))
    );
    expect(copy.fields.map((f: any) => f.pageId)).toEqual(["page-a", "page-b"]); // every field still sits on a page that exists
    expect(copy.branding).toMatchObject({ primaryColor: "#DC2626", logoUrl: "https://cdn.example/logo.png", coverImageUrl: "https://cdn.example/cover.png", fontFamily: "lora", cardStyle: "bordered", formWidth: "narrow" });
    expect(copy.settings).toMatchObject({ accessMode: "tracked", successMessage: "Thanks!", responseLimitEnabled: true, responseLimit: 50, honeypotEnabled: true });
  });

  it("does not carry the closing date, and still starts as an unpublished draft with its own link", async () => {
    const src: any = await original();
    const copy: any = await Form.findById((await duplicate(src._id.toString())).body.form._id).lean();
    expect(copy.settings.closeDate).toBeUndefined();
    expect(copy.status).toBe("draft");
    expect(copy.publishedSlug).toBeUndefined();
    expect(copy.slug).not.toBe(src.slug);
    expect(copy.title).toBe("Copy of Customer survey");
    expect(copy.contentVersion ?? 0).toBe(0);
  });

  it("shares nothing with the original: editing the copy leaves the original alone", async () => {
    const src: any = await original();
    const copy: any = (await duplicate(src._id.toString())).body.form;
    await Form.updateOne({ _id: copy._id }, { $set: { "branding.primaryColor": "#000000", "pages.0.title": "Changed" } });
    const orig: any = await Form.findById(src._id).lean();
    expect(orig.branding.primaryColor).toBe("#DC2626");
    expect(orig.pages[0].title).toBe("About you");
  });

  it("works for a form with no pages, branding or settings yet", async () => {
    const bare: any = await Form.create({ title: "Bare", workspaceId: ws._id, createdBy: owner._id, fields: [] });
    const res = await duplicate(bare._id.toString());
    expect(res.status).toBe(201);
    expect(res.body.form.title).toBe("Copy of Bare");
  });
});
