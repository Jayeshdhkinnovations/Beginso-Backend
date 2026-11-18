// CF unpublished-changes (Nov 2026): once a form is published, an edit (title, description, fields, pages, branding, settings other than the
// response limit) is staged on the form's draft instead of changing the live, public form. "Publish changes" (POST /:id/publish-changes) copies the
// draft onto the live form; "discard" (POST /:id/discard-draft) throws it away. The response limit and every status change (publish/unpublish/close)
// still act on the live form immediately. Update refuses (409 FORM_STALE) if the live form moved on since the draft was started.
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
import { FormService } from "../services/form.service";
import { staleFormError } from "../utils/staleForm";

process.env.JWT_SECRET = "test-jwt-secret-key-for-form-unpublished-changes";

let mongoServer: MongoMemoryServer;
let owner: any;
let ws: any;
const formService = new FormService();

const auth = () => ({ Authorization: `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role })}`, "x-workspace-id": ws._id.toString() });
const patch = (formId: string, body: any) => request(app).patch(`/api/forms/${formId}`).set(auth()).send(body);
const get = (formId: string) => request(app).get(`/api/forms/${formId}`).set(auth());
const publishChanges = (formId: string) => request(app).post(`/api/forms/${formId}/publish-changes`).set(auth()).send({});
const discardDraft = (formId: string) => request(app).post(`/api/forms/${formId}/discard-draft`).set(auth()).send({});

const mkPublishedForm = async (extra: Record<string, unknown> = {}) =>
  Form.create({
    title: "Live title",
    description: "Live description",
    workspaceId: ws._id,
    createdBy: owner._id,
    status: "published",
    publishedSlug: `live-${new mongoose.Types.ObjectId().toString()}`,
    publishedAt: new Date(),
    fields: [{ fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: false }],
    pages: [{ id: "p1", order: 0, title: "Page one" }],
    settings: { responseLimitEnabled: false },
    ...extra,
  } as any);

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  owner = await User.create({ firebaseUid: "uid-draft-owner", fullName: "Draft Owner", email: "draft-owner@test.com", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "Draft WS", slug: "draft-ws", timezone: "UTC", owner: owner._id });
  owner.workspaceId = ws._id;
  await owner.save();
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("editing a published form", () => {
  it("stages the content on the draft; the live title/fields/description are untouched", async () => {
    const form = await mkPublishedForm();
    const res = await patch(form._id.toString(), {
      title: "New title",
      description: "New description",
      fields: [{ fieldId: "f1", pageId: "p1", label: "Full name", type: "short_text", required: true }],
    });
    expect(res.status).toBe(200);
    // the response is the editable view: the draft's content, so the builder shows what was just typed
    expect(res.body.title).toBe("New title");
    expect(res.body.hasUnpublishedChanges).toBe(true);

    const stored = await Form.findById(form._id).lean();
    expect(stored!.title).toBe("Live title");
    expect(stored!.description).toBe("Live description");
    expect((stored!.fields as any[])[0].label).toBe("Name");
    expect(stored!.draft!.title).toBe("New title");
    expect((stored!.draft!.fields as any[])[0].label).toBe("Full name");
  });

  it("GET returns the draft's content and hasUnpublishedChanges, not the live content", async () => {
    const form = await mkPublishedForm();
    await patch(form._id.toString(), { title: "Staged" });
    const res = await get(form._id.toString());
    expect(res.body.title).toBe("Staged");
    expect(res.body.hasUnpublishedChanges).toBe(true);
  });

  it("does not bump the live contentVersion (the public form has not changed)", async () => {
    const form = await mkPublishedForm();
    const before = (await Form.findById(form._id).lean())!.contentVersion ?? 0;
    await patch(form._id.toString(), { title: "Staged again" });
    const after = (await Form.findById(form._id).lean())!.contentVersion ?? 0;
    expect(after).toBe(before);
  });

  it("a second edit builds on the draft, not on the live form again", async () => {
    const form = await mkPublishedForm();
    await patch(form._id.toString(), { title: "First edit" });
    const res = await patch(form._id.toString(), { description: "Second edit" });
    expect(res.body.title).toBe("First edit"); // kept from the first staged edit
    expect(res.body.description).toBe("Second edit");
  });

  it("the response limit applies live immediately, even while other edits are staged", async () => {
    const form = await mkPublishedForm();
    await patch(form._id.toString(), { title: "Staged title", settings: { responseLimit: 50, responseLimitEnabled: true } });
    const stored = await Form.findById(form._id).lean();
    expect(stored!.title).toBe("Live title"); // the title is still staged, not live
    expect((stored!.settings as any).responseLimitEnabled).toBe(true);
    expect((stored!.settings as any).responseLimit).toBe(50);
    expect(stored!.draft!.settings as any).not.toHaveProperty("responseLimit");
  });

  it("a status change (unpublish) acts on the live form directly, bypassing the draft entirely", async () => {
    const form = await mkPublishedForm();
    await patch(form._id.toString(), { title: "Staged, never published" });
    const res = await patch(form._id.toString(), { status: "draft" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("draft");
    const stored = await Form.findById(form._id).lean();
    expect(stored!.title).toBe("Live title"); // unpublish did not publish the staged title
    expect(stored!.draft).toBeTruthy(); // the draft is untouched, still there for when it is published again
  });
});

describe("publishing the staged changes", () => {
  it("copies the draft onto the live form and clears the draft", async () => {
    const form = await mkPublishedForm();
    await patch(form._id.toString(), {
      title: "Published now",
      fields: [{ fieldId: "f1", pageId: "p1", label: "Renamed", type: "short_text", required: false }, { fieldId: "f2", pageId: "p1", label: "New field", type: "email", required: true }],
    });
    const res = await publishChanges(form._id.toString());
    expect(res.status).toBe(200);
    expect(res.body.hasUnpublishedChanges).toBe(false);
    expect(res.body.title).toBe("Published now");

    const stored = await Form.findById(form._id).lean();
    expect(stored!.title).toBe("Published now");
    expect(stored!.draft).toBeFalsy();
    expect((stored!.fields as any[]).map((f: any) => f.label)).toEqual(["Renamed", "New field"]);
    expect(stored!.contentVersion).toBe(1); // the live form's own version moved, once
  });

  it("bumps schemaVersion only when the fields actually changed", async () => {
    const form = await mkPublishedForm();
    const before = (await Form.findById(form._id).lean())!.schemaVersion;
    await patch(form._id.toString(), { title: "Just a title change" });
    await publishChanges(form._id.toString());
    expect((await Form.findById(form._id).lean())!.schemaVersion).toBe(before);
  });

  it("refuses with 404-shaped NO_DRAFT when there is nothing staged", async () => {
    const form = await mkPublishedForm();
    const res = await publishChanges(form._id.toString());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NO_DRAFT");
  });

  it("refuses (409 FORM_STALE) when the live form moved on since the draft began, and changes nothing", async () => {
    const form = await mkPublishedForm();
    await formService.patchDraft(form._id.toString(), ws._id.toString(), { title: "Stale draft" });
    // the live form moves on without the draft knowing (simulating another publish-changes that already landed)
    await Form.updateOne({ _id: form._id }, { $set: { title: "Someone else published this" }, $inc: { contentVersion: 1 } });

    const res = await publishChanges(form._id.toString());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("FORM_STALE");
    const stored = await Form.findById(form._id).lean();
    expect(stored!.title).toBe("Someone else published this"); // the stale draft never overwrote it
    expect(stored!.draft).toBeTruthy(); // not silently dropped either
  });

  it("the service throws the same staleFormError shape directly", async () => {
    const form = await mkPublishedForm();
    await formService.patchDraft(form._id.toString(), ws._id.toString(), { title: "x" });
    await Form.updateOne({ _id: form._id }, { $inc: { contentVersion: 1 } });
    await expect(formService.publishDraftChanges(form._id.toString(), ws._id.toString())).rejects.toMatchObject({ code: "FORM_STALE" });
    expect((staleFormError(3) as any).code).toBe("FORM_STALE");
  });
});

describe("discarding the staged changes", () => {
  it("clears the draft and leaves the live form exactly as it was", async () => {
    const form = await mkPublishedForm();
    await patch(form._id.toString(), { title: "I changed my mind" });
    const res = await discardDraft(form._id.toString());
    expect(res.status).toBe(200);
    expect(res.body.hasUnpublishedChanges).toBe(false);
    expect(res.body.title).toBe("Live title");

    const stored = await Form.findById(form._id).lean();
    expect(stored!.draft).toBeFalsy();
    expect(stored!.title).toBe("Live title");
  });

  it("does nothing, and still succeeds, when there was no draft", async () => {
    const form = await mkPublishedForm();
    const res = await discardDraft(form._id.toString());
    expect(res.status).toBe(200);
    expect(res.body.hasUnpublishedChanges).toBe(false);
  });
});
