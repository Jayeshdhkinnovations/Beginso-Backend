// Sprint 14 - Insights, Search & Launch (backend). One suite per guarantee the frontend and the sprint gate
// depend on: the question breakdown counts real answers, completionRate has one meaning, saved charts are
// permission-checked, exports are audited, search never discloses what a caller may not see, activity emails
// never contain a response, and notifications never cross contexts.
process.env.JWT_SECRET = "test-jwt-secret-key-for-sprint14-insights-search-launch";
process.env.RATE_LIMIT_MAX = "0";
process.env.SEARCH_RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import fs from "fs";
import path from "path";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Notification from "../models/Notification";
import Template from "../models/Template";
import FormAccessGrant from "../models/FormAccessGrant";
import ReportModel from "../models/Report";
import SavedChart from "../models/SavedChart";
import { Event } from "../models/Event";
import { MailLog } from "../models/MailLog";
import { generateToken } from "../utils/generateToken";
import { mailService } from "../services/mail.service";
import { renderActivityEmail } from "../services/notificationMail";
import { sendActivityEmails, signUnsubscribeToken } from "../services/notificationEmail.service";
import { clearRateLimitStore } from "../middleware/rateLimiter";
import jwt from "jsonwebtoken";
import { migrateSprint14, rollbackSprint14 } from "../scripts/migrateSprint14";

let mongoServer: MongoMemoryServer;
let owner: any, member: any, viewer: any, outsider: any, sharee: any, solo: any;
let tOwner: string, tMember: string, tViewer: string, tOutsider: string, tSharee: string, tSolo: string;
let wsA: any, wsB: any;

const token = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role || "user" });
const as = (t: string, slug?: string) => ({ Authorization: `Bearer ${t}`, ...(slug ? { "x-workspace-slug": slug } : {}) });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fields = () => [
  { fieldId: "f-name", pageId: "p1", label: "Full name", type: "short_text", required: false },
  { fieldId: "f-plan", pageId: "p1", label: "Plan", type: "dropdown", required: false, options: ["Free", "Pro", "Team"] },
  { fieldId: "f-feat", pageId: "p1", label: "Features", type: "checkbox", required: false, options: ["Analytics", "Reports"] },
  { fieldId: "f-when", pageId: "p1", label: "Start date", type: "date", required: false },
];

const mkForm = (overrides: Record<string, any> = {}): Promise<any> =>
  Form.create({
    title: "Customer intake",
    workspaceId: wsA._id,
    createdBy: owner._id,
    status: "draft",
    fields: fields(),
    pages: [{ id: "p1", order: 0, title: "Page one" }],
    ...overrides,
  } as any);

const mkResp = (form: any, extra: Record<string, any> = {}) =>
  ResponseModel.create({ formId: form._id, answers: {}, submittedAt: new Date(), ...extra } as any);

const publicSubmit = (slug: string, answers: Record<string, any>) =>
  request(app)
    .post(`/api/public/${slug}/submit`)
    .field("data", JSON.stringify({ answers: Object.entries(answers).map(([fieldId, value]) => ({ fieldId, value })) }));

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Workspace.init(), Membership.init(), Form.init(), ResponseModel.init(), MailLog.init(), FormAccessGrant.init()]);

  const mk = (n: string) => User.create({ firebaseUid: `uid-s14-${n}`, fullName: `${n} Person`, email: `${n}@s14.test`, status: "active" });
  [owner, member, viewer, outsider, sharee, solo] = await Promise.all(["owner", "member", "viewer", "outsider", "sharee", "solo"].map(mk));
  [tOwner, tMember, tViewer, tOutsider, tSharee, tSolo] = [owner, member, viewer, outsider, sharee, solo].map(token);

  wsA = await Workspace.create({ name: "Alpha", slug: "ws-a", owner: owner._id });
  wsB = await Workspace.create({ name: "Beta", slug: "ws-b", owner: outsider._id });
  await Membership.create([
    { userId: owner._id, workspaceId: wsA._id, role: "owner", notificationPreference: "none" },
    { userId: member._id, workspaceId: wsA._id, role: "member", notificationPreference: "none" },
    { userId: viewer._id, workspaceId: wsA._id, role: "viewer", notificationPreference: "none" },
    { userId: outsider._id, workspaceId: wsB._id, role: "owner", notificationPreference: "none" },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

// ---------------------------------------------------------------------------------------------------
describe("BE 0.1 - B5.6 question breakdown returns real counts (seeded through the real submit path)", () => {
  it("counts dropdown and checkbox answers submitted via the public endpoint, including a date-only `to` on the last day", async () => {
    const form = await mkForm({ title: "Breakdown", status: "draft" });
    const pub = await request(app).post(`/api/forms/${form._id}/publish`).set(as(tOwner, "ws-a")).send({});
    expect(pub.status).toBe(200);
    const slug = pub.body.slug;

    for (const [plan, feat] of [["Pro", ["Analytics", "Reports"]], ["Pro", ["Analytics"]], ["Free", []], ["Team", ["Reports"]]] as const) {
      const r = await publicSubmit(slug, { "f-plan": plan, "f-feat": feat });
      expect(r.status).toBe(200);
    }
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/analytics/questions?formId=${form._id}&from=2020-01-01&to=${today}`)
      .set(as(tOwner, "ws-a"));
    expect(res.status).toBe(200);
    expect(res.body.data.totalResponses).toBe(4);
    const plan = res.body.data.questions.find((q: any) => q.fieldId === "f-plan");
    expect(Object.fromEntries(plan.summary.options.map((o: any) => [o.label, o.count]))).toEqual({ Free: 1, Pro: 2, Team: 1 });
    const feat = res.body.data.questions.find((q: any) => q.fieldId === "f-feat");
    expect(Object.fromEntries(feat.summary.options.map((o: any) => [o.label, o.count]))).toEqual({ Analytics: 2, Reports: 2 });
  });
});

describe("BE 0.1 - question breakdown: other plausible 'zeros' shapes", () => {
  const ask = async (form: any) =>
    (await request(app).get(`/api/analytics/questions?formId=${form._id}`).set(as(tOwner, "ws-a"))).body.data;
  const opts = (q: any) => Object.fromEntries(q.summary.options.map((o: any) => [o.label, o.count]));

  it("counts answers keyed by label only (the shape public submit really stores), fieldId-only, and mixed-case/whitespace values", async () => {
    const form = await mkForm({ title: "Shapes" });
    await mkResp(form, { answers: { Plan: "Pro", Features: ["Analytics", "Reports"] } }); // stored shape: label keys
    await mkResp(form, { answers: { "f-plan": " pro ", "f-feat": ["analytics"] } }); // legacy fieldId keys, sloppy values
    await mkResp(form, { answers: { Plan: "Free" } });
    const d = await ask(form);
    expect(opts(d.questions.find((q: any) => q.fieldId === "f-plan"))).toEqual({ Free: 1, Pro: 2, Team: 0 });
    expect(opts(d.questions.find((q: any) => q.fieldId === "f-feat"))).toEqual({ Analytics: 2, Reports: 1 });
  });

  it("number fields never report zero answered when answers exist (0 is a real answer), and multi-page forms are covered", async () => {
    const form = await mkForm({
      title: "Rating",
      fields: [
        { fieldId: "f-r", pageId: "p2", label: "Rating", type: "number", required: false },
        { fieldId: "f-n", pageId: "p1", label: "Age", type: "number", required: false },
      ],
      pages: [{ id: "p1", order: 0, title: "One" }, { id: "p2", order: 1, title: "Two" }],
    });
    await mkResp(form, { answers: { Rating: 5, Age: 0 } });
    await mkResp(form, { answers: { Rating: 3, Age: 31 } });
    const d = await ask(form);
    expect(d.questions.find((q: any) => q.fieldId === "f-r").totalAnswered).toBe(2);
    expect(d.questions.find((q: any) => q.fieldId === "f-n").totalAnswered).toBe(2);
  });

  it("excludes test and soft-deleted responses and soft-deleted fields, and counts every other row", async () => {
    const form = await mkForm({ title: "Excl" });
    await mkResp(form, { answers: { Plan: "Pro" } });
    await mkResp(form, { answers: { Plan: "Pro" }, isTest: true });
    await mkResp(form, { answers: { Plan: "Pro" }, deletedAt: new Date() });
    const d = await ask(form);
    expect(d.totalResponses).toBe(1);
    expect(opts(d.questions.find((q: any) => q.fieldId === "f-plan")).Pro).toBe(1);
  });

  it("a field renamed AFTER responses came in orphans earlier label-keyed answers (documented limitation)", async () => {
    // Known limitation, not a regression: submit stores label-keyed answers only, so a rename
    // orphans earlier answers (they show under no question). Pinned so a change is deliberate.
    const form = await mkForm({ title: "Renamed" });
    await mkResp(form, { answers: { Plan: "Pro" } });
    await Form.updateOne({ _id: form._id, "fields.fieldId": "f-plan" }, { $set: { "fields.$.label": "Subscription" } });
    const q = (await ask(form)).questions.find((x: any) => x.fieldId === "f-plan");
    expect(q.totalAnswered).toBe(0);
  });
});

describe("BE 0.5b - multi-page PDF export has no trailing blank page", () => {
  it("a 75-row export spans several pages, the footer total equals the real page count, and the LAST page holds data rows", async () => {
    const form = await mkForm({ title: "Long export" });
    await ResponseModel.insertMany(Array.from({ length: 75 }, (_, i) => ({ formId: form._id, answers: {}, status: "new", submittedAt: new Date(Date.now() - i * 1000) })));
    const created = await request(app).post("/api/reports").set(as(tOwner, "ws-a")).send({ format: "pdf", formId: String(form._id) });
    expect(created.status).toBe(202);
    const id = created.body.report._id;
    let report: any;
    for (let i = 0; i < 150; i++) {
      report = await ReportModel.findById(id);
      if (report.status === "completed" || report.status === "failed") break;
      await wait(100);
    }
    expect(report.status).toBe("completed");
    const file = await request(app).get(`/api/reports/${id}/file`).set(as(tOwner, "ws-a")).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    const buf = file.body as Buffer;
    const pageCount = (buf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);

    // Inflate every content stream; pdfkit emits one stream per page, in page order.
    const zlib = require("zlib");
    const streams: string[] = [];
    const re = /stream\r?\n/g;
    const raw = buf.toString("latin1");
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const end = raw.indexOf("endstream", m.index);
      try { streams.push(zlib.inflateSync(Buffer.from(raw.slice(m.index + m[0].length, end), "latin1")).toString("latin1")); } catch { /* not a flate stream */ }
    }
    // pdfkit writes text as kerned hex strings: join them back into readable text per page.
    const text = (t: string) => [...t.matchAll(/<([0-9a-f]+)>/g)].map((x) => Buffer.from(x[1], "hex").toString("latin1")).join("");
    const pageStreams = streams.filter((t) => /Page \d+ of \d+/.test(text(t)));
    expect(pageStreams).toHaveLength(pageCount);
    const last = text(pageStreams[pageStreams.length - 1]);
    expect(last).toContain(`Page ${pageCount} of ${pageCount}`);
    expect(last).toMatch(/[0-9a-f]{24}/); // a response id row sits on the last page: not a blank trailer
  });
});

// ---------------------------------------------------------------------------------------------------
describe("BE 0.2 / 0.4 - completionRate has one meaning (views based), reviewedRate keeps the old one, F15 exclusions", () => {
  it("is submissions / views, null with no views, excludes test + deleted responses and preview loads", async () => {
    const form = await mkForm({ title: "Rate form", viewsCount: 0 });
    await mkResp(form, { status: "completed" });
    await mkResp(form, { status: "new" });
    await mkResp(form, { status: "completed", isTest: true });
    await mkResp(form, { status: "completed", deletedAt: new Date() });

    const forms = async () => (await request(app).get("/api/analytics/forms?limit=50").set(as(tOwner, "ws-a"))).body.data.find((r: any) => r.formId === String(form._id));
    const overview = async () => (await request(app).get(`/api/analytics/overview?formId=${form._id}`).set(as(tOwner, "ws-a"))).body.data;

    let row = await forms();
    expect(row.completionRate).toBeNull(); // no counted views: never a made-up 0
    expect(row.views).toBeNull();
    expect(row.reviewedRate).toBe(50); // 1 completed of 2 counted
    expect((await overview()).completionRate).toBeNull();
    expect((await overview()).reviewedRate).toBe(50);

    await Form.updateOne({ _id: form._id }, { $set: { viewsCount: 8, status: "published", publishedSlug: "rate-form-slug" } });
    row = await forms();
    expect(row.completionRate).toBe(25); // 2 non-test non-deleted / 8 views
    expect(row.views).toBe(8);
    expect((await overview()).completionRate).toBe(25);
    expect((await overview()).views).toBe(8);

    // a preview load is never a view
    expect((await request(app).post("/api/public/rate-form-slug/view?preview=1")).status).toBe(204);
    expect((await Form.findById(form._id))!.viewsCount).toBe(8);
  });

  it("POST /api/templates/:id/use stores templateId + templateCategory, exposed on form read and analytics rows; other forms are null", async () => {
    const tpl = await Template.create({ name: "Event signup", category: "Events", theme: "default", fields: fields().map(({ pageId, ...f }) => f) as any });
    const res = await request(app).post(`/api/templates/${tpl._id}/use`).set(as(tOwner, "ws-a")).send({});
    expect(res.status).toBe(201);
    const id = res.body.data._id;
    const read = await request(app).get(`/api/forms/${id}`).set(as(tOwner, "ws-a"));
    expect(String(read.body.data?.templateId ?? read.body.form?.templateId ?? read.body.templateId)).toBe(String(tpl._id));
    const rows = (await request(app).get("/api/analytics/forms?limit=50").set(as(tOwner, "ws-a"))).body.data;
    expect(rows.find((r: any) => r.formId === id).templateCategory).toBe("Events");
    const plain = await mkForm({ title: "Plain" });
    expect(rows.concat((await request(app).get("/api/analytics/forms?limit=50").set(as(tOwner, "ws-a"))).body.data).find((r: any) => r.formId === String(plain._id))?.templateCategory ?? null).toBeNull();
    const ov = await request(app).get(`/api/forms/${id}/overview`).set(as(tOwner, "ws-a"));
    expect(ov.body.overview.templateCategory).toBe("Events");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("BE 0.3 - saved charts", () => {
  let form: any;
  beforeAll(async () => {
    form = await mkForm({ title: "Charts form" });
    await mkResp(form, { answers: { "f-plan": "Pro", "Plan": "Pro", "f-when": "2026-10-05" } });
    await mkResp(form, { answers: { "f-plan": "Pro", "f-when": "2026-10-06" } });
    await mkResp(form, { answers: { "f-plan": "Free", "f-when": "2026-10-06" } });
    await mkResp(form, { answers: { "f-plan": "Team" }, isTest: true }); // never counted
    await mkResp(form, { answers: { "f-plan": "Team" }, deletedAt: new Date() });
  });
  const url = (p = "") => `/api/forms/${form._id}/charts${p}`;

  it("write needs form edit rights; read needs analytics:read; another workspace is refused", async () => {
    const body = { fieldId: "f-plan", chartType: "donut", groupBy: "value" };
    expect((await request(app).post(url()).set(as(tViewer, "ws-a")).send(body)).status).toBe(403);
    expect((await request(app).post(url()).set(as(tOutsider, "ws-b")).send(body)).status).toBe(403);
    expect((await request(app).get(url()).set(as(tOutsider, "ws-b"))).status).toBe(403);
    const created = await request(app).post(url()).set(as(tMember, "ws-a")).send(body);
    expect(created.status).toBe(201);
    expect(created.body.chart).toMatchObject({ fieldId: "f-plan", chartType: "donut", groupBy: "value", fieldMissing: false });
    const list = await request(app).get(url()).set(as(tViewer, "ws-a")); // a viewer may read
    expect(list.status).toBe(200);
    expect(list.body.charts).toHaveLength(1);
    expect((await request(app).delete(url(`/${created.body.chart._id}`)).set(as(tViewer, "ws-a"))).status).toBe(403);
  });

  it("rejects combinations the field cannot support", async () => {
    const post = (b: any) => request(app).post(url()).set(as(tOwner, "ws-a")).send(b);
    expect((await post({ fieldId: "f-plan", chartType: "line", groupBy: "value" })).status).toBe(400);
    expect((await post({ fieldId: "f-plan", chartType: "bar", groupBy: "day" })).status).toBe(400);
    expect((await post({ fieldId: "f-when", chartType: "pie", groupBy: "day" })).status).toBe(400); // charts v2 allows bar on a date; pie stays invalid
    expect((await post({ fieldId: "f-when", chartType: "line", groupBy: "value" })).status).toBe(400);
    expect((await post({ fieldId: "f-name", chartType: "bar", groupBy: "value" })).status).toBe(400); // free text
    expect((await post({ fieldId: "nope", chartType: "bar", groupBy: "value" })).status).toBe(400);
  });

  it("data and preview exclude test + deleted responses, honour the date range, and flag a deleted question", async () => {
    const created = await request(app).post(url()).set(as(tOwner, "ws-a")).send({ fieldId: "f-when", chartType: "line", groupBy: "day" });
    const id = created.body.chart._id;
    const data = await request(app).get(url(`/${id}/data`)).set(as(tViewer, "ws-a"));
    expect(data.body.series).toEqual([{ label: "2026-10-05", value: 1 }, { label: "2026-10-06", value: 2 }]);
    expect(data.body.total).toBe(3);

    const pie = await request(app).post(url("/preview")).set(as(tViewer, "ws-a")).send({ fieldId: "f-plan", chartType: "bar", groupBy: "value" });
    expect(Object.fromEntries(pie.body.series.map((s: any) => [s.label, s.value]))).toEqual({ Free: 1, Pro: 2, Team: 0 });

    const none = await request(app).get(url(`/${id}/data?from=2999-01-01`)).set(as(tOwner, "ws-a"));
    expect(none.body.total).toBe(0);

    await Form.updateOne({ _id: form._id, "fields.fieldId": "f-when" }, { $set: { "fields.$.deleted": true } });
    const after = await request(app).get(url()).set(as(tOwner, "ws-a"));
    expect(after.body.charts.find((c: any) => c._id === id).fieldMissing).toBe(true);
    expect((await request(app).get(url(`/${id}/data`)).set(as(tOwner, "ws-a"))).body.fieldMissing).toBe(true);
    await Form.updateOne({ _id: form._id, "fields.fieldId": "f-when" }, { $set: { "fields.$.deleted": false } });
  });

  it("a chart id from another form is a 404, and delete removes it", async () => {
    const other = await mkForm({ title: "Other charts form" });
    const c = await request(app).post(`/api/forms/${other._id}/charts`).set(as(tOwner, "ws-a")).send({ fieldId: "f-plan", chartType: "bar", groupBy: "value" });
    expect((await request(app).get(url(`/${c.body.chart._id}/data`)).set(as(tOwner, "ws-a"))).status).toBe(404);
    expect((await request(app).delete(`/api/forms/${other._id}/charts/${c.body.chart._id}`).set(as(tOwner, "ws-a"))).status).toBe(200);
    expect(await SavedChart.countDocuments({ formId: other._id })).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("BE 0.5 / 0.5b - export audit trail and PDF pagination", () => {
  it("report.create records the row count; report.download is logged once the file is sent, never before", async () => {
    const form = await mkForm({ title: "Export form" });
    for (let i = 0; i < 3; i++) await mkResp(form, { status: "new" });
    await mkResp(form, { isTest: true });

    const created = await request(app).post("/api/reports").set(as(tOwner, "ws-a")).send({ format: "pdf", formId: String(form._id) });
    expect(created.status).toBe(202);
    const id = created.body.report._id;
    const createEvent = await Event.findOne({ action: "report.create", targetId: id });
    expect(createEvent!.metadata).toMatchObject({ format: "pdf", formId: String(form._id), rows: 3 });
    expect(createEvent!.actorEmail).toBe(owner.email);

    // not ready yet / not downloaded yet: nothing logged as a download
    expect(await Event.countDocuments({ action: "report.download", targetId: id })).toBe(0);

    let report: any;
    for (let i = 0; i < 100; i++) {
      report = await ReportModel.findById(id);
      if (report.status === "completed" || report.status === "failed") break;
      await wait(100);
    }
    expect(report.status).toBe("completed");

    // outsider cannot download (and so cannot create a download event)
    expect((await request(app).get(`/api/reports/${id}/file`).set(as(tOutsider, "ws-b"))).status).toBe(403);
    expect(await Event.countDocuments({ action: "report.download", targetId: id })).toBe(0);

    const file = await request(app).get(`/api/reports/${id}/file`).set(as(tViewer, "ws-a")).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    // a 3-row export is ONE page: no trailing near-blank pages (B5.7)
    const pages = (file.body as Buffer).toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? [];
    expect(pages).toHaveLength(1);

    await wait(150);
    const dl = await Event.findOne({ action: "report.download", targetId: id });
    expect(dl).toBeTruthy();
    expect(dl!.actorEmail).toBe(viewer.email);
    expect(dl!.metadata).toMatchObject({ format: "pdf", formId: String(form._id), rows: 3 });
    expect(JSON.stringify(dl!.metadata)).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);

    // an expired report returns 410 and logs nothing
    await ReportModel.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get(`/api/reports/${id}/file`).set(as(tOwner, "ws-a"))).status).toBe(410);
    await wait(100);
    expect(await Event.countDocuments({ action: "report.download", targetId: id })).toBe(1);
    if (report.filePath) fs.rmSync(report.filePath, { force: true });
  });
});

// ---------------------------------------------------------------------------------------------------
describe("BE 0.10 - report read/download enforce the per-form check (security critical, P5)", () => {
  const sendFile = async (reportId: string, t: string, slug?: string) => {
    const r = await request(app).get(`/api/reports/${reportId}/file`).set(as(t, slug));
    await wait(150);
    return r;
  };
  const mkReport = async (filters: Record<string, any>, workspaceId: any = wsA._id) => {
    const dir = path.resolve(process.cwd(), "uploads", "reports");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `s14-sec-${new mongoose.Types.ObjectId()}.csv`);
    fs.writeFileSync(filePath, "a,b\n1,2\n");
    return ReportModel.create({ workspaceId, format: "csv", filters, status: "completed", filePath, fileSize: 8, expiresAt: new Date(Date.now() + 3600_000) } as any);
  };
  const downloads = (id: any) => Event.countDocuments({ action: "report.download", targetId: String(id) });

  it("a reviewer granted form A can read/download A's report, not B's; non-member with no grant gets nothing", async () => {
    const reviewer = await User.create({ firebaseUid: "uid-s14-rev", fullName: "Rev", email: "rev@s14.test", status: "active" });
    const tRev = token(reviewer);
    const formA = await mkForm({ title: "A" });
    const formB = await mkForm({ title: "B" });
    await FormAccessGrant.create({ formId: formA._id, userId: reviewer._id, role: "reviewer" });
    const repA = await mkReport({ formId: String(formA._id) });
    const repB = await mkReport({ formId: String(formB._id) });
    const repAll = await mkReport({});

    expect((await request(app).get(`/api/reports/${repA._id}`).set(as(tRev))).status).toBe(200);
    expect((await sendFile(String(repA._id), tRev)).status).toBe(200);
    expect(await downloads(repA._id)).toBe(1);

    for (const rep of [repB, repAll]) {
      expect((await request(app).get(`/api/reports/${rep._id}`).set(as(tRev))).status).toBe(403);
      expect((await sendFile(String(rep._id), tRev)).status).toBe(403);
      expect(await downloads(rep._id)).toBe(0);
    }
    // sharee has no grant on A at all
    expect((await sendFile(String(repA._id), tSharee)).status).toBe(403);
    expect(await downloads(repA._id)).toBe(1);
  });

  it("workspace members still download (reviewers may export), cross-workspace is refused, no event on refusal", async () => {
    const form = await mkForm({ title: "Member export" });
    const rep = await mkReport({ formId: String(form._id) });
    expect((await sendFile(String(rep._id), tMember, "ws-a")).status).toBe(200);
    expect(await downloads(rep._id)).toBe(1);
    expect((await sendFile(String(rep._id), tOutsider, "ws-b")).status).toBe(403);
    expect((await request(app).get(`/api/reports/${rep._id}`).set(as(tOutsider, "ws-b"))).status).toBe(403);
    expect(await downloads(rep._id)).toBe(1);
  });

  it("a report whose form is trashed, or from another workspace, is a 404 and logs nothing", async () => {
    const trashed = await mkForm({ title: "Trashed" });
    const repT = await mkReport({ formId: String(trashed._id) });
    await Form.updateOne({ _id: trashed._id }, { $set: { deletedAt: new Date() } });
    const foreign = await Form.create({ title: "Foreign", workspaceId: wsB._id, createdBy: outsider._id, status: "draft", fields: fields(), pages: [{ id: "p1", order: 0, title: "P" }] } as any);
    const repF = await mkReport({ formId: String(foreign._id) });
    for (const rep of [repT, repF]) {
      expect((await sendFile(String(rep._id), tOwner, "ws-a")).status).toBe(404);
      expect((await request(app).get(`/api/reports/${rep._id}`).set(as(tOwner, "ws-a"))).status).toBe(404);
      expect(await downloads(rep._id)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("BE 0.6 - GET /api/search permission filtering (security critical)", () => {
  const SECRET = "ZEBRA-SECRET-ANSWER-7731";
  const search = (t: string, q: string, slug?: string, extra = "") => request(app).get(`/api/search?q=${encodeURIComponent(q)}${extra}`).set(as(t, slug));
  const all = (body: any) => Object.values(body.groups).flatMap((g: any) => g.items);
  let aForms: any[], bForm: any, archived: any, trashed: any, soloForm: any, grantedForm: any, hiddenForm: any;

  beforeAll(async () => {
    aForms = [];
    for (let i = 1; i <= 3; i++) aForms.push(await mkForm({ title: `Quokka survey ${i}`, status: "published" }));
    archived = await mkForm({ title: "Quokka archived", archivedAt: new Date() });
    trashed = await mkForm({ title: "Quokka trashed", deletedAt: new Date() });
    bForm = await Form.create({ title: "Quokka other workspace", workspaceId: wsB._id, createdBy: outsider._id, fields: fields(), pages: [{ id: "p1", order: 0 }] } as any);
    soloForm = await Form.create({ title: "Quokka personal", workspaceId: null, createdBy: solo._id, fields: fields(), pages: [{ id: "p1", order: 0 }] } as any);
    grantedForm = await mkForm({ title: "Quokka shared form" });
    hiddenForm = await mkForm({ title: "Quokka not shared" });
    await FormAccessGrant.create({ formId: grantedForm._id, userId: sharee._id, role: "reviewer" });

    await mkResp(aForms[0], { reference: "#142", respondentEmail: "dana@client.test", answers: { "Full name": SECRET } });
    await mkResp(aForms[0], { reference: "#143", answers: { "Full name": SECRET }, isTest: true });
    await mkResp(aForms[0], { reference: "#144", answers: {}, deletedAt: new Date() });
    await mkResp(trashed, { reference: "#142", respondentEmail: "dana@client.test" });
    await mkResp(bForm, { reference: "#142", respondentEmail: "dana@client.test" });
    await mkResp(hiddenForm, { reference: "#142", respondentEmail: "dana@client.test" });
    await Template.create([
      { name: "Quokka starter", category: "Events", theme: "default", fields: [] },
      { name: "Quokka private", category: "Events", theme: "default", fields: [], workspaceId: wsA._id },
      { name: "Quokka beta only", category: "Events", theme: "default", fields: [], workspaceId: wsB._id },
    ]);
  });

  it("totals count visible items only: archived, trashed and other-workspace forms are in neither the items nor the count", async () => {
    const res = await search(tMember, "quokka", "ws-a", "&types=forms&limit=2");
    expect(res.status).toBe(200);
    expect(res.body.answerSearch).toBe(false);
    expect(res.body.scope).toEqual({ kind: "workspace", label: "Alpha" });
    // visible: 3 published + shared form + hidden form (both are ordinary ws-a forms a member can see) = 5; limited to 2 items
    expect(res.body.groups.forms.total).toBe(5);
    expect(res.body.groups.forms.items).toHaveLength(2);
    const titles = (await search(tMember, "quokka", "ws-a", "&types=forms&limit=10")).body.groups.forms.items.map((i: any) => i.title);
    expect(titles).not.toContain("Quokka archived");
    expect(titles).not.toContain("Quokka trashed");
    expect(titles).not.toContain("Quokka other workspace");
    expect(titles).not.toContain("Quokka personal");
  });

  it("never crosses workspaces, and refuses a workspace the caller does not belong to", async () => {
    expect((await search(tOutsider, "quokka", "ws-a")).status).toBe(403);
    expect((await search(tMember, "quokka", "ws-b")).status).toBe(403);
    expect((await search(tMember, "quokka", "no-such-workspace")).status).toBe(403);
    const b = await search(tOutsider, "quokka", "ws-b");
    expect(b.status).toBe(200);
    expect(b.body.groups.forms.items.map((i: any) => i.title)).toEqual(["Quokka other workspace"]);
    expect(b.body.groups.templates.items.map((i: any) => i.title).sort()).toEqual(["Quokka beta only", "Quokka starter"]);
    const a = await search(tOwner, "quokka", "ws-a", "&types=templates");
    expect(a.body.groups.templates.items.map((i: any) => i.title).sort()).toEqual(["Quokka private", "Quokka starter"]);
  });

  it("responses match reference + respondent only: never answer text, never test/deleted/trashed-form rows, never answers in the payload", async () => {
    const byRef = await search(tMember, "#142", "ws-a", "&types=responses");
    const refs = byRef.body.groups.responses;
    expect(refs.total).toBe(2); // aForms[0] + hiddenForm; not the trashed form, not ws-b, not test (#143) / deleted (#144)
    expect(refs.items.map((i: any) => i.formTitle).sort()).toEqual(["Quokka not shared", "Quokka survey 1"]);
    expect((await search(tMember, "dana@client", "ws-a", "&types=responses")).body.groups.responses.total).toBe(2);

    const byAnswer = await search(tMember, SECRET, "ws-a");
    expect(all(byAnswer.body)).toHaveLength(0);
    expect(JSON.stringify((await search(tMember, "#142", "ws-a")).body)).not.toContain(SECRET);
    expect((await search(tMember, "#143", "ws-a", "&types=responses")).body.groups.responses.total).toBe(0);
    expect((await search(tMember, "#144", "ws-a", "&types=responses")).body.groups.responses.total).toBe(0);
  });

  it("members and templates are context scoped; personal context has no members group", async () => {
    const m = await search(tMember, "person", "ws-a", "&types=members&limit=10");
    expect(m.body.groups.members.items.map((i: any) => i.title).sort()).toEqual(["member Person", "owner Person", "viewer Person"]);
    expect(m.body.groups.members.items[0]).toHaveProperty("role");
    const personal = await search(tMember, "person", undefined, "&types=members");
    expect(personal.body.groups.members).toEqual({ total: 0, items: [] });
    expect(personal.body.scope.kind).toBe("personal");
  });

  it("personal context: own personal forms + forms shared by grant only; a revoked grant loses the result on the next request", async () => {
    const mine = await search(tSolo, "quokka", undefined, "&types=forms&limit=10");
    expect(mine.body.groups.forms.items.map((i: any) => i.title)).toEqual(["Quokka personal"]);

    const shared = await search(tSharee, "quokka", undefined, "&types=forms&limit=10");
    expect(shared.body.groups.forms.items.map((i: any) => i.title)).toEqual(["Quokka shared form"]);
    expect(shared.body.groups.forms.total).toBe(1);
    // a grant holder is NOT a workspace member: the workspace context stays closed to them
    expect((await search(tSharee, "quokka", "ws-a")).status).toBe(403);

    // responses: only on the shared form, and only that form's
    await mkResp(grantedForm, { reference: "#7", respondentEmail: "kim@client.test" });
    expect((await search(tSharee, "#7", undefined, "&types=responses")).body.groups.responses.total).toBe(1);
    expect((await search(tSharee, "#142", undefined, "&types=responses")).body.groups.responses.total).toBe(0); // hiddenForm / aForms not shared

    await FormAccessGrant.deleteOne({ formId: grantedForm._id, userId: sharee._id });
    expect((await search(tSharee, "quokka", undefined, "&types=forms")).body.groups.forms.total).toBe(0);
    expect((await search(tSharee, "#7", undefined, "&types=responses")).body.groups.responses.total).toBe(0);
  });

  it("a removed member loses every result on the very next request", async () => {
    const temp = await User.create({ firebaseUid: "uid-s14-temp", fullName: "Temp Person", email: "temp@s14.test", status: "active" });
    await Membership.create({ userId: temp._id, workspaceId: wsA._id, role: "member" });
    expect((await search(token(temp), "quokka", "ws-a", "&types=forms")).body.groups.forms.total).toBe(5);
    await Membership.deleteOne({ userId: temp._id, workspaceId: wsA._id });
    expect((await search(token(temp), "quokka", "ws-a")).status).toBe(403);
  });

  it("treats the query as literal text and bounds it", async () => {
    expect(all((await search(tMember, ".*", "ws-a")).body)).toHaveLength(0);
    expect(all((await search(tMember, "((", "ws-a")).body)).toHaveLength(0);
    expect((await search(tMember, "a", "ws-a")).status).toBe(400);
    expect((await search(tMember, "x".repeat(101), "ws-a")).status).toBe(400);
    expect((await search(tMember, "quokka", "ws-a", "&types=bogus")).status).toBe(400);
    expect((await search(tMember, "quokka", "ws-a", "&limit=500&types=forms")).body.groups.forms.items.length).toBeLessThanOrEqual(10);
    expect((await request(app).get("/api/search?q=quokka")).status).toBe(401);
  });

  it("is rate limited per user", async () => {
    process.env.SEARCH_RATE_LIMIT_MAX = "3";
    await clearRateLimitStore();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await search(tMember, "quokka", "ws-a")).status);
    process.env.SEARCH_RATE_LIMIT_MAX = "0";
    await clearRateLimitStore();
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("BE 0.7 - activity email: preference, content, idempotency, unsubscribe", () => {
  let spy: jest.SpyInstance;
  let sent: any[];
  let form: any;
  const SECRET = "ZEBRA-SECRET-ANSWER-4410";

  const setPrefs = async (prefs: Record<string, string>) => {
    for (const [uid, pref] of Object.entries(prefs)) {
      await Membership.updateOne({ userId: uid, workspaceId: wsA._id }, { $set: { notificationPreference: pref } });
    }
  };

  beforeEach(async () => {
    sent = [];
    spy = jest.spyOn(mailService, "sendMail").mockImplementation(async (o: any) => {
      sent.push(o);
      return true;
    });
    await MailLog.deleteMany({});
    await setPrefs({ [owner._id]: "none", [member._id]: "none", [viewer._id]: "none" });
    form = await mkForm({ title: "Email form", createdBy: owner._id });
  });
  afterEach(() => spy.mockRestore());

  it("new response: All gets it, Only mine gets it only for their own forms / assignments, None never", async () => {
    await setPrefs({ [owner._id]: "mine", [member._id]: "all", [viewer._id]: "mine" });
    const r = await mkResp(form, { reference: "#1", answers: { "Full name": SECRET } });
    expect(await sendActivityEmails({ kind: "new_response", formId: form._id, responseId: r._id, eventKey: String(r._id) })).toBe(2);
    expect(sent.map((o) => o.to).sort()).toEqual([member.email, owner.email].sort()); // viewer: "mine", not theirs

    sent.length = 0;
    const assigned = await mkResp(form, { reference: "#2", assigneeId: viewer._id });
    await sendActivityEmails({ kind: "new_response", formId: form._id, responseId: assigned._id, eventKey: String(assigned._id) });
    expect(sent.map((o) => o.to)).toContain(viewer.email);

    sent.length = 0;
    await setPrefs({ [owner._id]: "none", [member._id]: "none", [viewer._id]: "none" });
    const r3 = await mkResp(form, { reference: "#3" });
    expect(await sendActivityEmails({ kind: "new_response", formId: form._id, responseId: r3._id, eventKey: String(r3._id) })).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("the email body contains no answers, attachments or questions, whatever was submitted", async () => {
    await setPrefs({ [owner._id]: "all" });
    const r = await mkResp(form, { reference: "#9", answers: { "Full name": SECRET, Plan: "Pro", "f-name": SECRET, file: { fileName: "passport-scan.pdf" } } });
    await sendActivityEmails({ kind: "new_response", formId: form._id, responseId: r._id, eventKey: String(r._id) });
    expect(sent).toHaveLength(1);
    const rendered = renderActivityEmail(sent[0].activity);
    const everything = `${rendered.subject}\n${rendered.text}\n${rendered.html}`;
    for (const forbidden of [SECRET, "passport-scan", "Full name", "Start date", "Plan", "Features"]) expect(everything).not.toContain(forbidden);
    expect(everything).toContain("Email form");
    expect(everything).toContain("#9");
    expect(everything).toContain("/login?next=");
    expect(everything).toContain("/api/public/notifications/unsubscribe/");
  });

  it("test submissions never email; each event + recipient emails once even if processed twice; the send is logged", async () => {
    await setPrefs({ [owner._id]: "all" });
    const test = await mkResp(form, { reference: "#T", isTest: true });
    expect(await sendActivityEmails({ kind: "new_response", formId: form._id, responseId: test._id, eventKey: String(test._id) })).toBe(0);

    const r = await mkResp(form, { reference: "#4" });
    const ev = { kind: "new_response" as const, formId: form._id, responseId: r._id, eventKey: String(r._id) };
    expect(await sendActivityEmails(ev)).toBe(1);
    expect(await sendActivityEmails(ev)).toBe(0);
    expect(sent).toHaveLength(1);
    const logs = await MailLog.find({});
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ template: "new_response", outcome: "sent" });
    expect(JSON.stringify(logs[0].toObject())).not.toContain(owner.email); // hashed, never the address
  });

  it("a mail provider failure is recorded and never throws; submission does not wait for or depend on email", async () => {
    await setPrefs({ [owner._id]: "all" });
    spy.mockImplementation(async () => false);
    const r = await mkResp(form, { reference: "#5" });
    await expect(sendActivityEmails({ kind: "new_response", formId: form._id, responseId: r._id, eventKey: String(r._id) })).resolves.toBe(0);
    expect((await MailLog.findOne({}))!.outcome).toBe("failed");

    // end to end: a throwing mailer cannot fail or delay a public submission
    spy.mockImplementation(async () => {
      throw new Error("smtp down");
    });
    const pub = await request(app).post(`/api/forms/${form._id}/publish`).set(as(tOwner, "ws-a")).send({});
    const res = await publicSubmit(pub.body.slug, { "f-plan": "Pro" });
    expect(res.status).toBe(200);
    await wait(200);
    expect(await ResponseModel.countDocuments({ formId: form._id })).toBe(2); // the earlier fixture row + this submission
  });

  it("a public submission emails an 'All' member in the background, once", async () => {
    await setPrefs({ [member._id]: "all" });
    const pub = await request(app).post(`/api/forms/${form._id}/publish`).set(as(tOwner, "ws-a")).send({});
    expect((await publicSubmit(pub.body.slug, { "f-plan": "Pro", "f-name": SECRET })).status).toBe(200);
    await wait(300);
    expect(sent.filter((o) => o.to === member.email)).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain(SECRET);
  });

  it("mentions and assignments respect None and email only the addressee", async () => {
    const r = await mkResp(form, { reference: "#6" });
    await setPrefs({ [member._id]: "mine" });
    expect(await sendActivityEmails({ kind: "assignment", formId: form._id, responseId: r._id, eventKey: "n1", recipientUserId: member._id })).toBe(1);
    expect(sent[0].to).toBe(member.email);
    await setPrefs({ [member._id]: "none" });
    expect(await sendActivityEmails({ kind: "mention", formId: form._id, responseId: r._id, eventKey: "n2", recipientUserId: member._id })).toBe(0);
    // a user with no membership in the form's workspace is never emailed
    expect(await sendActivityEmails({ kind: "mention", formId: form._id, responseId: r._id, eventKey: "n3", recipientUserId: outsider._id })).toBe(0);
  });

  it("unsubscribe: signed + expiring, needs no session, sets the preference to none, idempotent", async () => {
    await setPrefs({ [member._id]: "all" });
    const m = await Membership.findOne({ userId: member._id, workspaceId: wsA._id });
    const t = signUnsubscribeToken(String(m!._id));
    const res = await request(app).get(`/api/public/notifications/unsubscribe/${t}`).set("Accept", "application/json");
    expect(res.status).toBe(200);
    expect((await Membership.findById(m!._id))!.notificationPreference).toBe("none");
    expect((await request(app).get(`/api/public/notifications/unsubscribe/${t}`)).status).toBe(200);

    expect((await request(app).get("/api/public/notifications/unsubscribe/garbage")).status).toBe(400);
    const expired = jwt.sign({ mid: String(m!._id) }, process.env.JWT_SECRET as string, { audience: "beginso:unsubscribe", expiresIn: -10 });
    expect((await request(app).get(`/api/public/notifications/unsubscribe/${expired}`)).status).toBe(410);
    const wrongAudience = jwt.sign({ mid: String(m!._id) }, process.env.JWT_SECRET as string, { expiresIn: "1d" });
    await Membership.updateOne({ _id: m!._id }, { $set: { notificationPreference: "all" } });
    expect((await request(app).get(`/api/public/notifications/unsubscribe/${wrongAudience}`)).status).toBe(400);
    expect((await Membership.findById(m!._id))!.notificationPreference).toBe("all");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("BE 0.8 - notifications: context scoping, filters, cursor, unread-count, read-all", () => {
  let n: any[];
  const mkN = (userId: any, workspaceId: any, over: Record<string, any> = {}) =>
    Notification.create({ userId, workspaceId, type: "mention", title: "t", message: "m", ...over });

  beforeAll(async () => {
    await Notification.deleteMany({});
    n = [];
    for (let i = 0; i < 5; i++) n.push(await mkN(member._id, wsA._id, { title: `A${i}`, createdAt: new Date(Date.now() - (10 - i) * 1000) }));
    n.push(await mkN(member._id, wsA._id, { type: "assignment", title: "assign", read: true }));
    n.push(await mkN(member._id, null, { title: "personal-1", type: "welcome" }));
    await Notification.collection.insertOne({ userId: member._id, type: "welcome", title: "legacy-no-ws", message: "m", read: false, createdAt: new Date(), updatedAt: new Date() });
    await Notification.collection.insertOne({ userId: member._id, workspaceId: new mongoose.Types.ObjectId(), type: "welcome", title: "legacy-dead-ws", message: "m", read: false, createdAt: new Date(), updatedAt: new Date() });
    await mkN(owner._id, wsA._id, { title: "someone-else" });
  });

  const list = (t: string, slug: string | undefined, qs = "") => request(app).get(`/api/notifications${qs}`).set(as(t, slug));

  it("the legacy call (no header, no params) is unchanged: newest 50 across contexts, no nextCursor", async () => {
    const res = await list(tMember, undefined);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(9);
    expect(res.body).not.toHaveProperty("nextCursor");
    expect(Object.keys(res.body.notifications[0]).sort()).toEqual(["createdAt", "id", "message", "read", "title", "type"]);
  });

  it("workspace context sees only its own; personal sees workspace-less and legacy-unusable rows (OQ-7); nobody sees another user's", async () => {
    const ws = await list(tMember, "ws-a", "?limit=50");
    expect(ws.body.notifications.map((x: any) => x.title).sort()).toEqual(["A0", "A1", "A2", "A3", "A4", "assign"]);
    expect(ws.body.nextCursor).toBeNull();
    const personal = await list(tMember, "personal", "?limit=50");
    expect(personal.body.notifications.map((x: any) => x.title).sort()).toEqual(["legacy-dead-ws", "legacy-no-ws", "personal-1"]);
    const asOwner = await list(tOwner, "ws-a", "?limit=50");
    expect(asOwner.body.notifications.map((x: any) => x.title)).toEqual(["someone-else"]);
  });

  it("a forged context header never widens access", async () => {
    expect((await list(tMember, "ws-b")).status).toBe(403);
    expect((await request(app).get("/api/notifications/unread-count").set(as(tMember, "ws-b"))).status).toBe(403);
    expect((await request(app).post("/api/notifications/read-all").set(as(tMember, "ws-b"))).status).toBe(403);
    expect((await list(tOutsider, "ws-a")).status).toBe(403);
  });

  it("filters by unread and type, validates type, and pages with an opaque cursor without gaps or repeats", async () => {
    expect((await list(tMember, "ws-a", "?unread=true&limit=50")).body.notifications.every((x: any) => x.read === false)).toBe(true);
    expect((await list(tMember, "ws-a", "?type=assignment")).body.notifications.map((x: any) => x.title)).toEqual(["assign"]);
    expect((await list(tMember, "ws-a", "?type=nonsense")).status).toBe(400);
    expect((await list(tMember, "ws-a", "?cursor=!!!")).status).toBe(400);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page: any = await list(tMember, "ws-a", `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.body.notifications.map((x: any) => x.id));
      cursor = page.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("unread-count and read-all are strictly caller + context scoped; read-all is idempotent", async () => {
    const count = async (t: string, slug?: string) => (await request(app).get("/api/notifications/unread-count").set(as(t, slug))).body.count;
    expect(await count(tMember, "ws-a")).toBe(5);
    expect(await count(tMember, "personal")).toBe(3);
    expect(await count(tOwner, "ws-a")).toBe(1);

    const first = await request(app).post("/api/notifications/read-all").set(as(tMember, "ws-a"));
    expect(first.body.updated).toBe(5);
    expect(await count(tMember, "ws-a")).toBe(0);
    expect(await count(tMember, "personal")).toBe(3); // other context untouched
    expect(await count(tOwner, "ws-a")).toBe(1); // other user untouched
    expect((await request(app).post("/api/notifications/read-all").set(as(tMember, "ws-a"))).body.updated).toBe(0);
    expect((await request(app).get("/api/notifications/unread-count")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("BE 0.11 / 0.12 - additive migration + health", () => {
  it("migrateSprint14 only builds indexes (never rewrites documents), is idempotent, and rolls back cleanly", async () => {
    const forms = await Form.countDocuments({}).setOptions({ includeDeleted: true });
    const dry = await migrateSprint14({ dryRun: true });
    expect(dry.before).toEqual(dry.after);
    const first = await migrateSprint14();
    const second = await migrateSprint14();
    expect(second.after).toEqual(first.after);
    expect(await Form.countDocuments({}).setOptions({ includeDeleted: true })).toBe(forms);
    expect((await rollbackSprint14()).length).toBe(3);
    expect(await rollbackSprint14()).toEqual([]); // already rolled back
    await migrateSprint14(); // and forward again
  });

  it("GET /api/health still answers and carries the build info keys", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    for (const key of ["commit", "commitMessage", "deployedAt"]) expect(res.body).toHaveProperty(key);
  });
});
