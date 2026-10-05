// Sprint 13 - Builder, Publish & the Respondent Side (backend). One suite per guarantee the frontend and
// the sprint gate depend on: publish keeps the slug, test submissions move no counter, trash cascades and
// restores, the retention sweep purges only what it should, signed links are scoped and single-use for
// account creation, and no respondent email can contain an answer.
process.env.JWT_SECRET = "test-jwt-secret-key-for-sprint13-builder-publish-respondent";
process.env.RATE_LIMIT_MAX = "0"; // the suite makes many public submissions from one address

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import RespondentLink from "../models/RespondentLink";
import Notification from "../models/Notification";
import Template from "../models/Template";
import ResponseReadState from "../models/ResponseReadState";
import { Event } from "../models/Event";
import { generateToken } from "../utils/generateToken";
import { mailService } from "../services/mail.service";
import { renderRespondentLinkEmail } from "../services/respondentMail";
import { purgeExpiredTrash } from "../services/trash.service";
import { evaluateReadiness } from "../services/readiness.service";
import { deleteWorkspaceData } from "../services/cleanup.service";
import { issueSubmitTicket } from "../services/submitTicket";
import { migrateAccessMode } from "../scripts/migrateAccessMode";
import { normaliseLayout } from "../utils/layout";

let mongoServer: MongoMemoryServer;
const DAY = 24 * 60 * 60 * 1000;

let owner: any, admin: any, editor: any, reviewer: any, outsider: any, respondent: any;
let tOwner: string, tAdmin: string, tEditor: string, tReviewer: string, tOutsider: string, tRespondent: string;
let wsA: any, wsB: any;

const token = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role || "user" });
const as = (t: string, slug = "ws-a") => ({ Authorization: `Bearer ${t}`, "x-workspace-slug": slug });

const baseFields = () => [
  { fieldId: "f-name", pageId: "p1", label: "Full name", type: "short_text", required: true },
  { fieldId: "f-email", pageId: "p1", label: "Email", type: "email", required: true },
];

const mkForm = async (overrides: Record<string, any> = {}): Promise<any> =>
  Form.create({
    title: "Test form",
    workspaceId: wsA._id,
    createdBy: owner._id,
    status: "draft",
    fields: baseFields(),
    pages: [{ id: "p1", order: 0, title: "Page one" }],
    ...overrides,
  } as any);

// Form.create with an untyped literal (the field `type` is a plain string here).
const rawForm = (doc: any): Promise<any> => Form.create(doc);

const publish = async (form: any, t = tOwner) =>
  request(app).post(`/api/forms/${form._id}/publish`).set(as(t)).send({});

const submitPublic = (slug: string, answers: Record<string, any>, extra: Record<string, any> = {}, headers: Record<string, string> = {}) =>
  request(app)
    .post(`/api/public/${slug}/submit`)
    .set(headers)
    .field(
      "data",
      JSON.stringify({
        answers: Object.entries(answers).map(([fieldId, value]) => ({ fieldId, value })),
        ...extra,
      })
    );

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Workspace.init(), Membership.init(), Form.init(), ResponseModel.init(), RespondentLink.init()]);

  const mk = (n: string) => User.create({ firebaseUid: `uid-s13-${n}`, fullName: `${n} User`, email: `${n}@s13.test`, status: "active" });
  [owner, admin, editor, reviewer, outsider, respondent] = await Promise.all(
    ["owner", "admin", "editor", "reviewer", "outsider", "respondent"].map(mk)
  );
  [tOwner, tAdmin, tEditor, tReviewer, tOutsider, tRespondent] = [owner, admin, editor, reviewer, outsider, respondent].map(token);

  wsA = await Workspace.create({ name: "Alpha", slug: "ws-a", owner: owner._id });
  wsB = await Workspace.create({ name: "Beta", slug: "ws-b", owner: outsider._id });
  await Membership.create([
    { userId: owner._id, workspaceId: wsA._id, role: "owner" },
    { userId: admin._id, workspaceId: wsA._id, role: "admin" },
    { userId: editor._id, workspaceId: wsA._id, role: "member" },
    { userId: reviewer._id, workspaceId: wsA._id, role: "viewer" },
    { userId: outsider._id, workspaceId: wsB._id, role: "owner" },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

// ---------------------------------------------------------------------------------------------------
describe("B1 - readiness, publish, unpublish, regenerate-link", () => {
  it("readiness separates blocking issues from warnings, with stable codes", async () => {
    const form = await mkForm({
      fields: [
        { fieldId: "a", pageId: "p1", label: "Pick", type: "dropdown", required: false, options: [] },
        { fieldId: "b", pageId: "p1", label: "Same", type: "short_text", required: false },
        { fieldId: "c", pageId: "p1", label: "same", type: "short_text", required: false },
      ],
    });
    const res = await request(app).get(`/api/forms/${form._id}/readiness`).set(as(tReviewer)); // forms:read is enough
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.blocking.map((i: any) => i.code)).toEqual(["CHOICE_FIELD_HAS_NO_OPTIONS"]);
    expect(res.body.blocking[0].fieldId).toBe("a");
    expect(res.body.warnings.map((i: any) => i.code)).toEqual(["FIELD_LABEL_DUPLICATE"]);
  });

  it("flags an empty label, a past closing date and Compact on a public form as warnings that never block", () => {
    // An empty label cannot be saved through the model any more, so legacy data is simulated directly.
    const result = evaluateReadiness({
      fields: [{ fieldId: "x", label: "   ", type: "short_text", required: false }] as any,
      settings: { layout: "compact", closeDate: new Date(Date.now() - DAY).toISOString() } as any,
    });
    expect(result.ready).toBe(true);
    expect(result.warnings.map((w) => w.code).sort()).toEqual(["CLOSE_DATE_IN_PAST", "FIELD_LABEL_EMPTY", "LAYOUT_COMPACT_PUBLIC"]);
    expect(result.blocking).toEqual([]);
  });

  it("a form with no visible fields cannot be published, and publish repeats the server-side check", async () => {
    const form = await mkForm({ fields: [] });
    const ready = await request(app).get(`/api/forms/${form._id}/readiness`).set(as(tOwner));
    expect(ready.body.blocking[0].code).toBe("FORM_HAS_NO_FIELDS");
    const res = await publish(form);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FORM_HAS_NO_FIELDS");
    expect((await Form.findById(form._id))!.status).toBe("draft");
  });

  it("publish returns the slug, and re-publishing keeps it (the live-bug fix, F10)", async () => {
    const form = await mkForm();
    const first = await publish(form);
    expect(first.status).toBe(200);
    expect(first.body.slug).toBeTruthy();
    await request(app).post(`/api/forms/${form._id}/close`).set(as(tOwner));
    const again = await publish(form);
    expect(again.body.slug).toBe(first.body.slug);
  });

  it("publish commits the pre-flight's access mode and closing date atomically", async () => {
    const form = await mkForm();
    const closeDate = new Date(Date.now() + 5 * DAY).toISOString();
    const res = await request(app).post(`/api/forms/${form._id}/publish`).set(as(tOwner)).send({ accessMode: "tracked", closeDate });
    expect(res.status).toBe(200);
    const stored = await Form.findById(form._id);
    expect(stored!.status).toBe("published");
    expect(stored!.settings!.accessMode).toBe("tracked");
    expect(stored!.settings!.closeDate).toBe(closeDate);
    const bad = await request(app).post(`/api/forms/${form._id}/publish`).set(as(tOwner)).send({ accessMode: "nonsense" });
    expect(bad.status).toBe(400);
  });

  it("unpublish returns the form to draft KEEPING its slug; the public link is down until re-publish, then identical", async () => {
    const form = await mkForm();
    const slug = (await publish(form)).body.slug;
    expect((await request(app).get(`/api/public/${slug}`)).status).toBe(200);

    const un = await request(app).post(`/api/forms/${form._id}/unpublish`).set(as(tOwner));
    expect(un.status).toBe(200);
    expect(un.body.status).toBe("draft");
    expect((await request(app).get(`/api/public/${slug}`)).status).toBe(404);
    expect((await request(app).post(`/api/forms/${form._id}/unpublish`).set(as(tOwner))).status).toBe(409);

    const back = await publish(form);
    expect(back.body.slug).toBe(slug);
    expect((await request(app).get(`/api/public/${slug}`)).status).toBe(200);
  });

  it("regenerate-link replaces the slug and the OLD slug stops resolving at once", async () => {
    const form = await mkForm();
    const oldSlug = (await publish(form)).body.slug;
    const res = await request(app).post(`/api/forms/${form._id}/regenerate-link`).set(as(tOwner));
    expect(res.status).toBe(200);
    expect(res.body.previousSlugInvalidated).toBe(true);
    expect(res.body.slug).not.toBe(oldSlug);
    expect((await request(app).get(`/api/public/${oldSlug}`)).status).toBe(404);
    expect((await request(app).get(`/api/public/${res.body.slug}`)).status).toBe(200);

    const draft = await mkForm();
    expect((await request(app).post(`/api/forms/${draft._id}/regenerate-link`).set(as(tOwner))).status).toBe(409);
  });

  it("only Owner/Admin can publish, unpublish or regenerate; Editor and Reviewer get 403", async () => {
    const form = await mkForm();
    for (const t of [tEditor, tReviewer]) {
      expect((await publish(form, t)).status).toBe(403);
      expect((await request(app).post(`/api/forms/${form._id}/unpublish`).set(as(t))).status).toBe(403);
      expect((await request(app).post(`/api/forms/${form._id}/regenerate-link`).set(as(t))).status).toBe(403);
    }
    expect((await publish(form, tAdmin)).status).toBe(200);
  });

  it("another workspace cannot reach any of these routes (workspace scoping)", async () => {
    const form = await mkForm();
    for (const [method, path] of [
      ["get", `/api/forms/${form._id}/readiness`],
      ["post", `/api/forms/${form._id}/unpublish`],
      ["post", `/api/forms/${form._id}/archive`],
      ["post", `/api/forms/${form._id}/test-submissions`],
    ] as const) {
      const res = await (request(app) as any)[method](path).set(as(tOutsider, "ws-b")).send({});
      expect([403, 404]).toContain(res.status);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("B3 - layout presets", () => {
  it("accepts the six presets and the three legacy values, rejects anything else", async () => {
    const form = await mkForm();
    for (const layout of ["classic", "card_stack", "guided", "steps", "split_feature", "compact", "single_column", "two_column"]) {
      const res = await request(app).patch(`/api/forms/${form._id}`).set(as(tOwner)).send({ settings: { layout } });
      expect(res.status).toBe(200);
    }
    const bad = await request(app).patch(`/api/forms/${form._id}`).set(as(tOwner)).send({ settings: { layout: "masonry" } });
    expect(bad.status).toBe(400);
  });

  it("normalises legacy values on read, with no data migration", async () => {
    expect(normaliseLayout("single_column")).toBe("classic");
    expect(normaliseLayout("two_column")).toBe("compact");
    expect(normaliseLayout("compact")).toBe("compact");
    expect(normaliseLayout(undefined)).toBe("classic");
    expect(normaliseLayout("nonsense")).toBe("classic");

    const form = await mkForm({ settings: { layout: "two_column" } });
    const slug = (await publish(form)).body.slug;
    const pub = await request(app).get(`/api/public/${slug}`);
    expect(pub.body.settings.layout).toBe("compact");
    expect((await Form.findById(form._id))!.settings!.layout).toBe("two_column"); // stored value untouched
  });
});

// ---------------------------------------------------------------------------------------------------
describe("B4 - access modes", () => {
  it("a form with no stored mode is Mode 1 (open); the public form exposes the mode", async () => {
    const form = await mkForm();
    const slug = (await publish(form)).body.slug;
    expect((await request(app).get(`/api/public/${slug}`)).body.settings.accessMode).toBe("open");
    const res = await submitPublic(slug, { "f-name": "Ann", "f-email": "ann@x.com" });
    expect(res.status).toBe(200);
  });

  it("PATCH settings that omit accessMode never silently reset it", async () => {
    const form = await mkForm({ settings: { accessMode: "tracked" } });
    await request(app).patch(`/api/forms/${form._id}`).set(as(tOwner)).send({ settings: { honeypotEnabled: true } });
    expect((await Form.findById(form._id))!.settings!.accessMode).toBe("tracked");
  });

  it("the backfill gives every existing form an explicit 'open', is idempotent, and supports a dry run", async () => {
    await Form.collection.insertOne({ title: "Legacy", workspaceId: wsA._id, status: "draft", fields: [], pages: [], settings: {}, createdAt: new Date(), updatedAt: new Date() });
    const dry = await migrateAccessMode({ dryRun: true });
    expect(dry.matched).toBeGreaterThan(0);
    expect(dry.modified).toBe(0);
    const run = await migrateAccessMode();
    expect(run.modified).toBeGreaterThan(0);
    const again = await migrateAccessMode();
    expect(again.matched).toBe(0);
    expect((await Form.findOne({ title: "Legacy" }))!.settings!.accessMode).toBe("open");
  });

  describe("Mode 2 - tracked", () => {
    it("requires a valid email (422 EMAIL_REQUIRED), stores it, and emails a link", async () => {
      const form = await mkForm({ title: "Tracked form", settings: { accessMode: "tracked" } });
      const slug = (await publish(form)).body.slug;
      const spy = jest.spyOn(mailService, "sendMail").mockResolvedValue(undefined);

      const missing = await submitPublic(slug, { "f-name": "Bea", "f-email": "bea@x.com" });
      expect(missing.status).toBe(422);
      expect(missing.body.error.code).toBe("EMAIL_REQUIRED");
      const bad = await submitPublic(slug, { "f-name": "Bea", "f-email": "bea@x.com" }, { respondentEmail: "not-an-email" });
      expect(bad.status).toBe(422);
      expect(await ResponseModel.countDocuments({ formId: form._id })).toBe(0);

      const ok = await submitPublic(slug, { "f-name": "Bea", "f-email": "bea@x.com" }, { respondentEmail: " Bea@Example.com " });
      expect(ok.status).toBe(200);
      const stored = await ResponseModel.findOne({ formId: form._id });
      expect(stored!.respondentEmail).toBe("bea@example.com");
      expect(await RespondentLink.countDocuments({ responseId: stored!._id })).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ to: "bea@example.com", template: "respondent_submission_link", formName: "Tracked form" });
      spy.mockRestore();
    });
  });

  describe("Mode 3 - login (submit ticket)", () => {
    it("refuses without a ticket, accepts a valid one once, and takes the email from the ACCOUNT", async () => {
      const form = await mkForm({ settings: { accessMode: "login" } });
      const slug = (await publish(form)).body.slug;

      const anon = await submitPublic(slug, { "f-name": "Cy", "f-email": "cy@x.com" });
      expect(anon.status).toBe(401);
      expect(anon.body.error.code).toBe("LOGIN_REQUIRED");

      const ticketRes = await request(app).post(`/api/public/${slug}/submit-ticket`).set({ Authorization: `Bearer ${tRespondent}` });
      expect(ticketRes.status).toBe(200);
      const { ticket } = ticketRes.body;

      const ok = await submitPublic(slug, { "f-name": "Cy", "f-email": "cy@x.com" }, { respondentEmail: "attacker@evil.test" }, { "x-submit-ticket": ticket });
      expect(ok.status).toBe(200);
      const stored = await ResponseModel.findOne({ formId: form._id });
      expect(String(stored!.respondentUserId)).toBe(String(respondent._id));
      expect(stored!.respondentEmail).toBe("respondent@s13.test"); // never the request body's address

      const replay = await submitPublic(slug, { "f-name": "Cy", "f-email": "cy@x.com" }, {}, { "x-submit-ticket": ticket });
      expect(replay.status).toBe(401); // single use
    });

    it("a ticket is bound to one form, expires, and cannot be forged", async () => {
      const formA = await mkForm({ settings: { accessMode: "login" } });
      const formB = await mkForm({ settings: { accessMode: "login" } });
      const slugA = (await publish(formA)).body.slug;
      const slugB = (await publish(formB)).body.slug;

      const { ticket } = issueSubmitTicket(respondent._id.toString(), formA._id.toString());
      expect((await submitPublic(slugB, { "f-name": "x", "f-email": "x@x.com" }, {}, { "x-submit-ticket": ticket })).status).toBe(401);

      const [payload] = ticket.split(".");
      expect((await submitPublic(slugA, { "f-name": "x", "f-email": "x@x.com" }, {}, { "x-submit-ticket": `${payload}.forged` })).status).toBe(401);

      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60 * 1000);
      expect((await submitPublic(slugA, { "f-name": "x", "f-email": "x@x.com" }, {}, { "x-submit-ticket": ticket })).status).toBe(401);
      jest.restoreAllMocks();
    });

    it("the ticket endpoint needs a session and only serves login-mode forms", async () => {
      const open = await mkForm();
      const openSlug = (await publish(open)).body.slug;
      expect((await request(app).post(`/api/public/${openSlug}/submit-ticket`)).status).toBe(401);
      expect((await request(app).post(`/api/public/${openSlug}/submit-ticket`).set({ Authorization: `Bearer ${tRespondent}` })).status).toBe(409);
    });
  });
});

// ---------------------------------------------------------------------------------------------------
describe("B2 - test submissions move no counter (F15)", () => {
  it("a test submission is stored with isTest and goes through the real validation", async () => {
    const form = await mkForm();
    const bad = await request(app).post(`/api/forms/${form._id}/test-submissions`).set(as(tEditor)).send({ answers: [{ fieldId: "f-name", value: "Tess" }] });
    expect(bad.status).toBe(422); // the required email is missing: same rules as a real submission
    const ok = await request(app)
      .post(`/api/forms/${form._id}/test-submissions`)
      .set(as(tEditor))
      .send({ answers: [{ fieldId: "f-name", value: "Tess" }, { fieldId: "f-email", value: "tess@x.com" }] });
    expect(ok.status).toBe(201);
    expect(ok.body.isTest).toBe(true);
    const stored = await ResponseModel.findById(ok.body._id);
    expect(stored!.isTest).toBe(true);
    expect(stored!.reference).toBeUndefined(); // never consumes the public #reference sequence
    expect(stored!.answers["Full name"]).toBe("Tess");
  });

  it("a Reviewer cannot send one; another workspace cannot either", async () => {
    const form = await mkForm();
    expect((await request(app).post(`/api/forms/${form._id}/test-submissions`).set(as(tReviewer)).send({})).status).toBe(403);
    expect((await request(app).post(`/api/forms/${form._id}/test-submissions`).set(as(tOutsider, "ws-b")).send({})).status).toBe(403);
  });

  it("every collection-level read excludes tests by default - list, stats, counts, aggregates - and the list can opt in", async () => {
    const form = await mkForm();
    const slug = (await publish(form)).body.slug;
    await submitPublic(slug, { "f-name": "Real", "f-email": "real@x.com" });
    await request(app).post(`/api/forms/${form._id}/test-submissions`).set(as(tOwner)).send({ answers: [{ fieldId: "f-name", value: "T" }, { fieldId: "f-email", value: "t@x.com" }] });
    expect(await ResponseModel.countDocuments({ formId: form._id, isTest: true })).toBe(1);

    expect(await ResponseModel.countDocuments({ formId: form._id })).toBe(1); // model-level hook
    expect(await ResponseModel.find({ formId: form._id })).toHaveLength(1);
    const agg = await ResponseModel.aggregate([{ $match: { formId: form._id } }, { $count: "n" }]);
    expect(agg[0].n).toBe(1);

    const list = await request(app).get(`/api/responses?formId=${form._id}`).set(as(tOwner));
    expect(list.body.total).toBe(1);
    const withTests = await request(app).get(`/api/responses?formId=${form._id}&includeTest=true`).set(as(tOwner));
    expect(withTests.body.total).toBe(2);
    expect(withTests.body.data.filter((r: any) => r.isTest)).toHaveLength(1);

    const stats = await request(app).get(`/api/responses/stats?formId=${form._id}`).set(as(tOwner));
    expect(JSON.stringify(stats.body)).not.toMatch(/"total":2/);
    const forms = await request(app).get("/api/forms").set(as(tOwner));
    expect(forms.body.forms.find((f: any) => String(f._id) === String(form._id)).responseCount).toBe(1);
    const overview = await request(app).get(`/api/forms/${form._id}/overview`).set(as(tOwner));
    expect(JSON.stringify(overview.body)).not.toMatch(/"responseCount":2/);
  });

  it("a test never trips the response limit, closes the form, or flags a duplicate", async () => {
    const form = await mkForm({ settings: { responseLimitEnabled: true, responseLimit: 1 } });
    const slug = (await publish(form)).body.slug;
    for (let i = 0; i < 3; i++) {
      const r = await request(app).post(`/api/forms/${form._id}/test-submissions`).set(as(tOwner)).send({ answers: [{ fieldId: "f-name", value: "T" }, { fieldId: "f-email", value: "same@x.com" }] });
      expect(r.status).toBe(201);
    }
    expect((await Form.findById(form._id))!.status).toBe("published");
    const real = await submitPublic(slug, { "f-name": "Real", "f-email": "same@x.com" });
    expect(real.status).toBe(200);
    const stored = await ResponseModel.findOne({ formId: form._id });
    expect(stored!.duplicateOfId).toBeNull(); // tests are not "earlier responses"
    expect(stored!.reference).toBe("#1"); // the public sequence was not consumed
  });
});

// ---------------------------------------------------------------------------------------------------
describe("B5 - archive", () => {
  it("archive hides the form from the default list, never expires, takes the link down, and is Owner/Admin only", async () => {
    const form = await mkForm({ title: "Archive me" });
    const slug = (await publish(form)).body.slug;
    expect((await request(app).post(`/api/forms/${form._id}/archive`).set(as(tEditor))).status).toBe(403);
    expect((await request(app).post(`/api/forms/${form._id}/archive`).set(as(tAdmin))).status).toBe(200);
    expect((await request(app).post(`/api/forms/${form._id}/archive`).set(as(tAdmin))).status).toBe(409);

    const ids = async (qs = "") => (await request(app).get(`/api/forms${qs}`).set(as(tOwner))).body.forms.map((f: any) => String(f._id));
    expect(await ids()).not.toContain(String(form._id));
    expect(await ids("?archived=only")).toContain(String(form._id));
    expect(await ids("?archived=true")).toContain(String(form._id));
    expect((await request(app).get(`/api/public/${slug}`)).status).toBe(404);
    expect((await publish(form)).status).toBe(409); // archived forms are unarchived first

    // an archived form keeps everything and is still reachable by id
    expect((await request(app).get(`/api/forms/${form._id}`).set(as(tOwner))).status).toBe(200);
    expect((await request(app).post(`/api/forms/${form._id}/unarchive`).set(as(tOwner))).status).toBe(200);
    expect(await ids()).toContain(String(form._id));
  });
});

// ---------------------------------------------------------------------------------------------------
describe("B5 - Trash, cascade and retention", () => {
  it("DELETE /forms/:id is now reversible: the form vanishes everywhere, nothing is destroyed", async () => {
    const form = await mkForm({ title: "Doomed" });
    const slug = (await publish(form)).body.slug;
    await submitPublic(slug, { "f-name": "A", "f-email": "a@x.com" });

    const del = await request(app).delete(`/api/forms/${form._id}`).set(as(tOwner));
    expect(del.status).toBe(200);
    expect(new Date(del.body.purgeAt).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);

    expect((await request(app).get(`/api/forms/${form._id}`).set(as(tOwner))).status).toBe(404);
    expect((await request(app).get(`/api/public/${slug}`)).status).toBe(404);
    const list = await request(app).get("/api/forms").set(as(tOwner));
    expect(list.body.forms.map((f: any) => String(f._id))).not.toContain(String(form._id));
    // the data is all still there
    expect(await Form.findOne({ _id: form._id }).setOptions({ includeDeleted: true })).not.toBeNull();
    expect(await ResponseModel.countDocuments({ formId: form._id })).toBe(1);
    // and the form's responses are hidden with it
    const inbox = await request(app).get("/api/responses").set(as(tOwner));
    expect(inbox.body.data.filter((r: any) => r.formId === String(form._id))).toHaveLength(0);
  });

  it("only the Owner can delete a form (Admin cannot) - the matrix is unchanged", async () => {
    const form = await mkForm();
    expect((await request(app).delete(`/api/forms/${form._id}`).set(as(tAdmin))).status).toBe(403);
    expect((await request(app).delete(`/api/forms/${form._id}`).set(as(tEditor))).status).toBe(403);
  });

  it("the Trash list is Owner/Admin only, carries server-computed countdowns and who may act", async () => {
    const form = await mkForm({ title: "Listed in trash" });
    await request(app).delete(`/api/forms/${form._id}`).set(as(tOwner));

    expect((await request(app).get("/api/trash").set(as(tEditor))).status).toBe(403);
    expect((await request(app).get("/api/trash").set(as(tReviewer))).status).toBe(403);

    const asOwner = await request(app).get("/api/trash").set(as(tOwner));
    const item = asOwner.body.items.find((i: any) => i.id === String(form._id));
    expect(item).toMatchObject({ type: "form", name: "Listed in trash", canRestore: true, canPurge: true });
    expect(item.daysLeft).toBe(30);
    expect(item.deletedBy.name).toBe("owner User");
    expect(typeof asOwner.body.storageBytes).toBe("number");

    const asAdmin = await request(app).get("/api/trash").set(as(tAdmin));
    const seen = asAdmin.body.items.find((i: any) => i.id === String(form._id));
    expect(seen.canRestore).toBe(false); // form restore is Owner-only
    expect(seen.canPurge).toBe(false);
  });

  it("restoring a form brings back the form AND its responses; Admin may not", async () => {
    const form = await mkForm({ title: "Restore me" });
    const slug = (await publish(form)).body.slug;
    await submitPublic(slug, { "f-name": "A", "f-email": "a@x.com" });
    await submitPublic(slug, { "f-name": "B", "f-email": "b@x.com" });
    await request(app).delete(`/api/forms/${form._id}`).set(as(tOwner));

    expect((await request(app).post(`/api/trash/form/${form._id}/restore`).set(as(tAdmin))).status).toBe(403);
    const res = await request(app).post(`/api/trash/form/${form._id}/restore`).set(as(tOwner));
    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/forms/${form._id}`).set(as(tOwner))).status).toBe(200);
    expect((await request(app).get(`/api/public/${slug}`)).status).toBe(200); // same link as before
    const inbox = await request(app).get(`/api/responses?formId=${form._id}`).set(as(tOwner));
    expect(inbox.body.total).toBe(2);
  });

  it("a response deleted on its own lands in Trash and restores on its own; Admin can restore it", async () => {
    const form = await mkForm();
    const slug = (await publish(form)).body.slug;
    await submitPublic(slug, { "f-name": "A", "f-email": "a@x.com" });
    const response = (await ResponseModel.findOne({ formId: form._id }))!;

    expect((await request(app).delete(`/api/responses/${response._id}`).set(as(tAdmin))).status).toBe(204);
    expect((await ResponseModel.findById(response._id))!.deletedAt).toBeTruthy(); // soft, not destroyed
    const trash = await request(app).get("/api/trash?type=response").set(as(tAdmin));
    const item = trash.body.items.find((i: any) => i.id === String(response._id));
    expect(item).toMatchObject({ type: "response", canRestore: true });

    expect((await request(app).post(`/api/trash/response/${response._id}/restore`).set(as(tAdmin))).status).toBe(200);
    expect((await ResponseModel.findById(response._id))!.deletedAt).toBeNull();
  });

  it("restoring a response whose form is in Trash is refused (409) and names the form", async () => {
    const form = await mkForm({ title: "Parent form" });
    const slug = (await publish(form)).body.slug;
    await submitPublic(slug, { "f-name": "A", "f-email": "a@x.com" });
    const response = (await ResponseModel.findOne({ formId: form._id }))!;
    await request(app).delete(`/api/responses/${response._id}`).set(as(tOwner));
    await request(app).delete(`/api/forms/${form._id}`).set(as(tOwner));
    const res = await request(app).post(`/api/trash/response/${response._id}/restore`).set(as(tOwner));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("FORM_IN_TRASH");
    expect(res.body.message).toContain("Parent form");
  });

  it("permanent deletion needs the typed confirmation (checked by the SERVER) and is Owner-only for forms", async () => {
    const form = await mkForm();
    await request(app).delete(`/api/forms/${form._id}`).set(as(tOwner));

    const noConfirm = await request(app).delete(`/api/trash/form/${form._id}`).set(as(tOwner)).send({});
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error.code).toBe("CONFIRMATION_REQUIRED");
    expect((await request(app).delete(`/api/trash/form/${form._id}`).set(as(tAdmin)).send({ confirm: "DELETE" })).status).toBe(403);
    expect(await Form.findOne({ _id: form._id }).setOptions({ includeDeleted: true })).not.toBeNull();

    expect((await request(app).delete(`/api/trash/form/${form._id}`).set(as(tOwner)).send({ confirm: "DELETE" })).status).toBe(200);
    expect(await Form.findOne({ _id: form._id }).setOptions({ includeDeleted: true })).toBeNull();
  });

  it("Empty trash removes forms (Owner) and responses, and leaves live data alone", async () => {
    const trashed = await mkForm({ title: "Trashed" });
    const live = await mkForm({ title: "Live" });
    await request(app).delete(`/api/forms/${trashed._id}`).set(as(tOwner));
    const res = await request(app).delete("/api/trash").set(as(tOwner)).send({ confirm: "DELETE" });
    expect(res.status).toBe(200);
    expect(res.body.forms).toBeGreaterThanOrEqual(1);
    expect(await Form.findOne({ _id: trashed._id }).setOptions({ includeDeleted: true })).toBeNull();
    expect(await Form.findById(live._id)).not.toBeNull();
  });

  it("personal-space Trash is scoped to the creator; nobody else can see or restore it", async () => {
    const mine = await rawForm({ title: "My personal form", workspaceId: null, createdBy: respondent._id, status: "draft", fields: baseFields(), pages: [{ id: "p1", order: 0 }] });
    const personal = (t: string) => ({ Authorization: `Bearer ${t}`, "x-workspace-slug": "personal" });
    expect((await request(app).delete(`/api/forms/${mine._id}`).set(personal(tRespondent))).status).toBe(200);

    const own = await request(app).get("/api/trash").set(personal(tRespondent));
    expect(own.body.items.map((i: any) => i.id)).toContain(String(mine._id));
    expect(own.body.items.find((i: any) => i.id === String(mine._id)).canRestore).toBe(true);

    const other = await request(app).get("/api/trash").set(personal(tOutsider));
    expect(other.body.items.map((i: any) => i.id)).not.toContain(String(mine._id));
    expect((await request(app).post(`/api/trash/form/${mine._id}/restore`).set(personal(tOutsider))).status).toBe(404);
    expect((await request(app).post(`/api/trash/form/${mine._id}/restore`).set(personal(tRespondent))).status).toBe(200);
  });

  describe("retention sweep", () => {
    it("purges items trashed more than 30 days ago (with their files, responses and dependants) and nothing else", async () => {
      const old = await mkForm({ title: "Old trash" });
      const recent = await mkForm({ title: "Recent trash" });
      const archived = await mkForm({ title: "Archived forever", archivedAt: new Date(Date.now() - 400 * DAY) });
      const live = await mkForm({ title: "Still live" });
      await ResponseModel.create({ formId: old._id, answers: { a: 1 } });
      await ResponseModel.create({ formId: archived._id, answers: { a: 1 } });
      await Form.updateOne({ _id: old._id }, { $set: { deletedAt: new Date(Date.now() - 31 * DAY) } });
      await Form.updateOne({ _id: recent._id }, { $set: { deletedAt: new Date(Date.now() - 29 * DAY) } });

      const result = await purgeExpiredTrash();
      expect(result.forms).toBeGreaterThanOrEqual(1);

      const exists = async (id: any) => !!(await Form.findOne({ _id: id }).setOptions({ includeDeleted: true }));
      expect(await exists(old._id)).toBe(false);
      expect(await ResponseModel.countDocuments({ formId: old._id }).setOptions({ includeTest: true })).toBe(0);
      expect(await exists(recent._id)).toBe(true); // 29 days: not yet
      expect(await exists(archived._id)).toBe(true); // archived forms never expire
      expect(await ResponseModel.countDocuments({ formId: archived._id })).toBe(1);
      expect(await exists(live._id)).toBe(true);
    });

    it("purges individually-deleted responses past the window, and is idempotent", async () => {
      const form = await mkForm();
      const stale = await ResponseModel.create({ formId: form._id, answers: { a: 1 }, deletedAt: new Date(Date.now() - 40 * DAY) });
      const fresh = await ResponseModel.create({ formId: form._id, answers: { a: 2 }, deletedAt: new Date(Date.now() - 2 * DAY) });
      await purgeExpiredTrash();
      expect(await ResponseModel.findById(stale._id)).toBeNull();
      expect(await ResponseModel.findById(fresh._id)).not.toBeNull();
      const second = await purgeExpiredTrash(); // running it again is a no-op
      expect(second.responses).toBe(0);
    });
  });

  it("workspace deletion still removes forms that are sitting in Trash (no orphans)", async () => {
    const ws = await Workspace.create({ name: "Doomed ws", slug: "doomed-ws", owner: outsider._id });
    const form = await rawForm({ title: "Trashed in doomed ws", workspaceId: ws._id, createdBy: outsider._id, status: "draft", fields: baseFields(), pages: [{ id: "p1", order: 0 }], deletedAt: new Date() });
    await deleteWorkspaceData(ws._id);
    expect(await Form.findOne({ _id: form._id }).setOptions({ includeDeleted: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("B6 - respondent links, edit-after-review, claim, my submissions", () => {
  let form: any;
  let slug: string;
  let spy: jest.SpyInstance;
  let sentLinks: string[];

  const submitTracked = async (email: string, name = "Dee") => {
    const res = await submitPublic(slug, { "f-name": name, "f-email": "typed@x.com" }, { respondentEmail: email });
    expect(res.status).toBe(200);
    return (await ResponseModel.findOne({ formId: form._id, respondentEmail: email.toLowerCase() }).sort({ createdAt: -1 }))!;
  };
  const tokenFromMail = () => sentLinks[sentLinks.length - 1].split("/r/")[1];

  beforeEach(async () => {
    form = await mkForm({ title: "Tracked intake", settings: { accessMode: "tracked" } });
    slug = (await publish(form)).body.slug;
    sentLinks = [];
    spy = jest.spyOn(mailService, "sendMail").mockImplementation(async (o: any) => {
      sentLinks.push(o.actionUrl);
    });
  });
  afterEach(() => spy.mockRestore());

  it("A5.5 - the respondent email contains no response data, whatever was submitted", async () => {
    const secret = "ZEBRA-SECRET-ANSWER-9981";
    const res = await submitPublic(slug, { "f-name": secret, "f-email": "top-secret@answer.test" }, { respondentEmail: "reader@example.com" });
    expect(res.status).toBe(200);

    expect(spy).toHaveBeenCalledTimes(1);
    const options: any = spy.mock.calls[0][0];
    const rendered = renderRespondentLinkEmail({ formName: options.formName, actionUrl: options.actionUrl, expiresAt: options.expiresAt });
    const everything = `${rendered.subject}\n${rendered.text}\n${rendered.html}`;
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain("top-secret@answer.test");
    expect(everything).not.toContain("Full name"); // not even the questions
    expect(everything).not.toContain("Email");
    expect(everything).toContain("Tracked intake"); // only the form's name
    expect(everything).toContain(options.actionUrl);
    // and the options handed to the mailer carry nothing but name, link and expiry
    expect(Object.keys(options).sort()).toEqual(["actionUrl", "expiresAt", "formName", "template", "to"]);
  });

  it("the email escapes a hostile form name instead of injecting markup", () => {
    const html = renderRespondentLinkEmail({ formName: '<script>alert("x")</script>', actionUrl: "https://beginso.com/r/abc", expiresAt: new Date() }).html;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("a signed link shows the respondent THEIR answers and nothing about the workflow", async () => {
    const response = await submitTracked("dee@example.com");
    // give the response every piece of internal state a reviewer could have added
    await ResponseModel.updateOne({ _id: response._id }, { $set: { assigneeId: admin._id, status: "in_progress", tagIds: [new mongoose.Types.ObjectId()] } });

    const res = await request(app).get(`/api/respond/${tokenFromMail()}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("valid");
    expect(res.body.formName).toBe("Tracked intake");
    expect(res.body.status).toBe("In review");
    expect(res.body.canEdit).toBe(true);
    expect(res.body.fields.find((f: any) => f.fieldId === "f-name").value).toBe("Dee");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");

    const body = JSON.stringify(res.body);
    for (const leak of ["stage", "tag", "assignee", "note", "score", "ipHash", String(admin._id), "reference"]) {
      expect(body.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("a token that never existed, was rotated away or is malformed is simply invalid (404); an expired one is 410", async () => {
    const response = await submitTracked("dee@example.com");
    const first = tokenFromMail();
    expect((await request(app).get("/api/respond/not-a-real-token-at-all-0000")).status).toBe(404);
    expect((await request(app).get("/api/respond/x")).status).toBe(404);

    // resend rotates: the previous token stops working
    await request(app).post("/api/respond/resend").send({ email: "dee@example.com", slug });
    expect(tokenFromMail()).not.toBe(first);
    expect((await request(app).get(`/api/respond/${first}`)).status).toBe(404);
    expect((await request(app).get(`/api/respond/${tokenFromMail()}`)).status).toBe(200);

    await RespondentLink.updateMany({ responseId: response._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request(app).get(`/api/respond/${tokenFromMail()}`);
    expect(expired.status).toBe(410);
    expect(expired.body.state).toBe("expired");
    expect(expired.body.fields).toBeUndefined();
  });

  it("one token reaches one response only", async () => {
    await submitTracked("one@example.com", "One");
    const tokenOne = tokenFromMail();
    await submitTracked("two@example.com", "Two");
    const res = await request(app).get(`/api/respond/${tokenOne}`);
    expect(JSON.stringify(res.body)).toContain("One");
    expect(JSON.stringify(res.body)).not.toContain("Two");
  });

  it("resend always answers 202, whether or not anything matched", async () => {
    await submitTracked("known@example.com");
    const before = sentLinks.length;
    expect((await request(app).post("/api/respond/resend").send({ email: "known@example.com", slug })).status).toBe(202);
    expect(sentLinks.length).toBe(before + 1);
    expect((await request(app).post("/api/respond/resend").send({ email: "stranger@example.com", slug })).status).toBe(202);
    expect((await request(app).post("/api/respond/resend").send({ email: "stranger@example.com", slug: "no-such-form" })).status).toBe(202);
    expect(sentLinks.length).toBe(before + 1); // nothing was sent to a stranger
  });

  it("editing validates by the form's own rules and leaves stage, assignee and tags alone", async () => {
    const response = await submitTracked("edit@example.com");
    const bad = await request(app).patch(`/api/respond/${tokenFromMail()}`).send({ answers: { "f-email": "not-an-email" } });
    expect(bad.status).toBe(422);
    expect((await ResponseModel.findById(response._id))!.answers.Email).toBe("typed@x.com"); // unchanged

    const ok = await request(app).patch(`/api/respond/${tokenFromMail()}`).send({ answers: { "f-name": "Dee Fixed" } });
    expect(ok.status).toBe(200);
    expect(ok.body.editedAfterReview).toBe(false); // nobody had looked yet
    const after = await ResponseModel.findById(response._id);
    expect(after!.answers["Full name"]).toBe("Dee Fixed");
    expect(after!.editedAfterReviewAt).toBeNull();
    expect(after!.lastEditedByRespondentAt).toBeTruthy();
    expect((await request(app).patch(`/api/respond/${tokenFromMail()}`).send({ answers: {} })).status).toBe(422);
  });

  it("A5.2 - editing after review sets 'Edited after review', writes an event, and notifies the ASSIGNEE", async () => {
    const response = await submitTracked("late@example.com");
    await ResponseModel.updateOne({ _id: response._id }, { $set: { assigneeId: editor._id, status: "in_progress" } });

    const res = await request(app).patch(`/api/respond/${tokenFromMail()}`).send({ answers: { "f-name": "Late Edit" } });
    expect(res.status).toBe(200);
    expect(res.body.editedAfterReview).toBe(true);

    const after = await ResponseModel.findById(response._id);
    expect(after!.editedAfterReviewAt).toBeTruthy();
    expect(String(after!.assigneeId)).toBe(String(editor._id)); // assignee untouched
    expect(after!.status).toBe("in_progress"); // stage untouched

    const note = await Notification.findOne({ userId: editor._id, type: "response_edited" });
    expect(note).not.toBeNull();
    expect(note!.message).toContain("Tracked intake");
    expect(await Event.countDocuments({ workspaceId: wsA._id, action: "response.edit_after_review" })).toBeGreaterThanOrEqual(1);

    // the respondent now sees "Edited"; a member can clear the flag
    expect((await request(app).get(`/api/respond/${tokenFromMail()}`)).body.status).toBe("Edited");
    expect((await request(app).patch(`/api/responses/${response._id}/edited-after-review`).set(as(tReviewer)).send({ cleared: true })).status).toBe(403);
    const clear = await request(app).patch(`/api/responses/${response._id}/edited-after-review`).set(as(tEditor)).send({ cleared: true });
    expect(clear.status).toBe(200);
    expect((await ResponseModel.findById(response._id))!.editedAfterReviewAt).toBeNull();
  });

  it("an unassigned response that was opened by a member notifies the workspace owner", async () => {
    const response = await submitTracked("opened@example.com");
    await ResponseReadState.create({ responseId: response._id, userId: admin._id, readAt: new Date() } as any);
    await request(app).patch(`/api/respond/${tokenFromMail()}`).send({ answers: { "f-name": "After Open" } });
    expect(await Notification.countDocuments({ userId: owner._id, type: "response_edited" })).toBeGreaterThanOrEqual(1);
  });

  it("a completed response is locked, and a closed or archived form is read-only (409), with the reason", async () => {
    const response = await submitTracked("locked@example.com");
    await ResponseModel.updateOne({ _id: response._id }, { $set: { status: "completed" } });
    const view = await request(app).get(`/api/respond/${tokenFromMail()}`);
    expect(view.body.canEdit).toBe(false);
    expect(view.body.readOnlyReason).toBe("finalised");
    const res = await request(app).patch(`/api/respond/${tokenFromMail()}`).send({ answers: { "f-name": "Too late" } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SUBMISSION_READ_ONLY");

    await ResponseModel.updateOne({ _id: response._id }, { $set: { status: "new" } });
    await request(app).post(`/api/forms/${form._id}/archive`).set(as(tOwner));
    expect((await request(app).get(`/api/respond/${tokenFromMail()}`)).body.readOnlyReason).toBe("archived");
  });

  describe("claim - an account only ever comes from the link", () => {
    it("needs a session, requires the matching email, and works once", async () => {
      const response = await submitTracked("respondent@s13.test"); // the address of the `respondent` account
      const t = tokenFromMail();

      expect((await request(app).post(`/api/respond/${t}/claim`)).status).toBe(401);
      const wrong = await request(app).post(`/api/respond/${t}/claim`).set({ Authorization: `Bearer ${tOutsider}` });
      expect(wrong.status).toBe(409);
      expect(wrong.body.error.code).toBe("EMAIL_MISMATCH");
      expect((await ResponseModel.findById(response._id))!.respondentUserId).toBeNull();

      const ok = await request(app).post(`/api/respond/${t}/claim`).set({ Authorization: `Bearer ${tRespondent}` });
      expect(ok.status).toBe(200);
      expect(ok.body.linked).toBeGreaterThanOrEqual(1);
      expect(String((await ResponseModel.findById(response._id))!.respondentUserId)).toBe(String(respondent._id));

      const second = await request(app).post(`/api/respond/${t}/claim`).set({ Authorization: `Bearer ${tRespondent}` });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("LINK_USED");
      // after the account exists the link stops exposing data; the signed-in portal is the way in
      const view = await request(app).get(`/api/respond/${t}`);
      expect(view.body.state).toBe("used");
      expect(view.body.fields).toBeUndefined();
      expect((await request(app).patch(`/api/respond/${t}`).send({ answers: { "f-name": "x" } })).status).toBe(409);
    });

    it("submitting a form never creates a user", async () => {
      const before = await User.countDocuments();
      await submitTracked("nobody@example.com");
      expect(await User.countDocuments()).toBe(before);
    });
  });

  describe("my submissions (signed-in respondent)", () => {
    let portal: any;
    let tPortal: string;
    beforeAll(async () => {
      portal = await User.create({ firebaseUid: "uid-s13-portal", fullName: "Portal User", email: "portal@s13.test", status: "active" });
      tPortal = token(portal);
    });

    it("lists ONLY my own, with a respondent-safe status, and never someone else's", async () => {
      const mine = await submitTracked("portal@s13.test", "Mine");
      await submitTracked("somebody@else.test", "Theirs");
      await request(app).post(`/api/respond/${tokenFromMail()}/claim`).set({ Authorization: `Bearer ${tOutsider}` }); // mismatched: links nothing
      await ResponseModel.updateOne({ _id: mine._id }, { $set: { respondentUserId: portal._id, status: "in_progress" } });

      const list = await request(app).get("/api/my-submissions").set({ Authorization: `Bearer ${tPortal}` });
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ id: String(mine._id), formName: "Tracked intake", ownerName: "Alpha", status: "In review", canEdit: true });
      expect(Object.keys(list.body.items[0]).sort()).toEqual(["canEdit", "formName", "id", "ownerName", "status", "submittedAt"]);

      const theirs = (await ResponseModel.findOne({ respondentEmail: "somebody@else.test" }))!;
      expect((await request(app).get(`/api/my-submissions/${theirs._id}`).set({ Authorization: `Bearer ${tPortal}` })).status).toBe(404);
      expect((await request(app).patch(`/api/my-submissions/${theirs._id}`).set({ Authorization: `Bearer ${tPortal}` }).send({ answers: { "f-name": "x" } })).status).toBe(404);
      expect((await request(app).get("/api/my-submissions")).status).toBe(401);
    });

    it("detail and edit work for the owner, and a trashed form drops out of the portal", async () => {
      const mine = await submitTracked("portal@s13.test", "Mine");
      await ResponseModel.updateOne({ _id: mine._id }, { $set: { respondentUserId: portal._id } });
      const auth = { Authorization: `Bearer ${tPortal}` };

      const detail = await request(app).get(`/api/my-submissions/${mine._id}`).set(auth);
      expect(detail.body.fields.find((f: any) => f.fieldId === "f-name").value).toBe("Mine");
      expect((await request(app).patch(`/api/my-submissions/${mine._id}`).set(auth).send({ answers: { "f-name": "Mine v2" } })).status).toBe(200);
      expect((await ResponseModel.findById(mine._id))!.answers["Full name"]).toBe("Mine v2");

      await request(app).delete(`/api/forms/${form._id}`).set(as(tOwner));
      const ids = (await request(app).get("/api/my-submissions").set(auth)).body.items.map((i: any) => i.id);
      expect(ids).not.toContain(String(mine._id)); // its form is in Trash
      await request(app).post(`/api/trash/form/${form._id}/restore`).set(as(tOwner));
      const back = (await request(app).get("/api/my-submissions").set(auth)).body.items.map((i: any) => i.id);
      expect(back).toContain(String(mine._id)); // and it returns on restore
    });
  });
});

// ---------------------------------------------------------------------------------------------------
describe("B7 - workspace templates", () => {
  it("Editor and above can publish a form as a template; a Reviewer cannot", async () => {
    const form = await mkForm({ title: "Source form", settings: { layout: "steps", closeDate: new Date(Date.now() + DAY).toISOString() }, branding: { primaryColor: "#112233" } });
    expect((await request(app).post("/api/templates").set(as(tReviewer)).send({ formId: String(form._id) })).status).toBe(403);
    const res = await request(app).post("/api/templates").set(as(tEditor)).send({ formId: String(form._id), name: "Our intake" });
    expect(res.status).toBe(201);
    const t = await Template.findById(res.body.data._id);
    expect(t).toMatchObject({ name: "Our intake", theme: "workspace" });
    expect(String(t!.workspaceId)).toBe(String(wsA._id));
    expect(String(t!.sourceFormId)).toBe(String(form._id));
    expect((t!.toObject() as any).settings.layout).toBe("steps");
    expect((t!.toObject() as any).settings.closeDate).toBeUndefined(); // a date belongs to one run
    expect((t!.toObject() as any).branding.primaryColor).toBe("#112233");
  });

  it("a form from another workspace cannot be published as a template", async () => {
    const foreign = await rawForm({ title: "Foreign", workspaceId: wsB._id, createdBy: outsider._id, status: "draft", fields: baseFields(), pages: [{ id: "p1", order: 0 }] });
    expect((await request(app).post("/api/templates").set(as(tOwner)).send({ formId: String(foreign._id) })).status).toBe(404);
  });

  it("the list returns both sources for members, ONLY built-ins elsewhere", async () => {
    await Template.create({ name: "Built-in X", category: "Test", theme: "classic-light", fields: [{ label: "Q", type: "short_text", required: false }], isActive: true });
    const form = await mkForm({ title: "To publish" });
    await request(app).post("/api/templates").set(as(tOwner)).send({ formId: String(form._id), name: "Alpha private" });

    const names = (res: any) => res.body.data.map((t: any) => `${t.source}:${t.name}`);
    const mine = await request(app).get("/api/templates").set(as(tReviewer));
    expect(names(mine)).toEqual(expect.arrayContaining(["workspace:Alpha private", "beginso:Built-in X"]));

    const other = await request(app).get("/api/templates").set(as(tOutsider, "ws-b"));
    expect(names(other).some((n: string) => n.includes("Alpha private"))).toBe(false);
    expect(names(other)).toContain("beginso:Built-in X");

    const publicGallery = await request(app).get("/api/templates/public");
    expect(publicGallery.body.data.some((t: any) => t.name === "Alpha private")).toBe(false);
    const personal = await request(app).get("/api/templates").set({ Authorization: `Bearer ${tOwner}`, "x-workspace-slug": "personal" });
    expect(personal.body.data.some((t: any) => t.name === "Alpha private")).toBe(false);
  });

  it("only members can use a workspace template; the copy carries settings and theme but never responses", async () => {
    const form = await mkForm({ title: "Source", settings: { layout: "guided" }, branding: { primaryColor: "#abcdef" } });
    const slug = (await publish(form)).body.slug;
    await submitPublic(slug, { "f-name": "Secret", "f-email": "s@x.com" });
    const created = await request(app).post("/api/templates").set(as(tOwner)).send({ formId: String(form._id), name: "Reusable" });
    const id = created.body.data._id;

    const stranger = await request(app).post(`/api/templates/${id}/use`).set(as(tOutsider, "ws-b")).send({ destinationWorkspaceId: String(wsB._id) });
    expect(stranger.status).toBe(404);

    const used = await request(app).post(`/api/templates/${id}/use`).set(as(tEditor)).send({ destinationWorkspaceId: String(wsA._id) });
    expect(used.status).toBe(201);
    const copy = (await Form.findById(used.body.data._id))!;
    expect(copy.status).toBe("draft");
    expect(copy.settings!.layout).toBe("guided");
    expect((copy.branding as any).primaryColor).toBe("#abcdef");
    expect(copy.publishedSlug).toBeUndefined();
    expect(await ResponseModel.countDocuments({ formId: copy._id })).toBe(0);
  });

  it("only Owner/Admin can remove a workspace template, and never a built-in one", async () => {
    const form = await mkForm();
    const created = await request(app).post("/api/templates").set(as(tOwner)).send({ formId: String(form._id), name: "Removable" });
    const id = created.body.data._id;
    expect((await request(app).delete(`/api/templates/${id}`).set(as(tEditor))).status).toBe(403);
    expect((await request(app).delete(`/api/templates/${id}`).set(as(tOutsider, "ws-b"))).status).toBe(404);
    expect((await request(app).delete(`/api/templates/${id}`).set(as(tAdmin))).status).toBe(200);
    expect(await Template.findById(id)).toBeNull();

    const builtIn = await Template.create({ name: "Built-in Y", category: "Test", theme: "classic-light", fields: [{ label: "Q", type: "short_text", required: false }], isActive: true });
    expect((await request(app).delete(`/api/templates/${builtIn._id}`).set(as(tOwner))).status).toBe(404);
    expect(await Template.findById(builtIn._id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("events for the new lifecycle actions", () => {
  it("publish, unpublish, regenerate, archive, trash and restore are all recorded", async () => {
    const form = await mkForm({ title: "Evented" });
    await publish(form);
    await request(app).post(`/api/forms/${form._id}/unpublish`).set(as(tOwner));
    await publish(form);
    await request(app).post(`/api/forms/${form._id}/regenerate-link`).set(as(tOwner));
    await request(app).post(`/api/forms/${form._id}/archive`).set(as(tOwner));
    await request(app).post(`/api/forms/${form._id}/unarchive`).set(as(tOwner));
    await request(app).delete(`/api/forms/${form._id}`).set(as(tOwner));
    await request(app).post(`/api/trash/form/${form._id}/restore`).set(as(tOwner));

    const actions = (await Event.find({ workspaceId: wsA._id, targetId: String(form._id) })).map((e) => e.action);
    for (const expected of ["form.publish", "form.unpublish", "form.regenerate_link", "form.archive", "form.unarchive", "form.trash", "form.restore"]) {
      expect(actions).toContain(expected);
    }
  });
});
