// Charts v2: the single-field aggregate, the responses list filtered by field value (chart count == panel count),
// per-user / per-form charts (visibility, reorder, duplicate), the Sprint 14 compatibility shape, and the migration.
process.env.JWT_SECRET = "test-jwt-secret-key-for-charts-v2";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import FormAccessGrant from "../models/FormAccessGrant";
import SavedChart from "../models/SavedChart";
import { generateToken } from "../utils/generateToken";
import { countReportRows } from "../services/report.service";
import ReportModel from "../models/Report";
import { migrateChartsV2, rollbackChartsV2 } from "../scripts/migrateChartsV2";

let mongoServer: MongoMemoryServer;
const U: Record<string, any> = {};
const T: Record<string, string> = {};
let wsA: any, wsB: any, form: any, personal: any;

const as = (who: string, slug: string | null = "ws-a") => ({ Authorization: `Bearer ${T[who]}`, ...(slug ? { "x-workspace-slug": slug } : {}) });

const fields = () => [
  { fieldId: "f-plan", pageId: "p1", label: "Plan", type: "dropdown", required: false, options: ["Free", "Pro", "Team"] },
  { fieldId: "f-feat", pageId: "p1", label: "Features", type: "checkbox", required: false, options: ["Analytics", "Reports"] },
  { fieldId: "f-rate", pageId: "p1", label: "Rating", type: "number", required: false },
  { fieldId: "f-when", pageId: "p1", label: "Start date", type: "date", required: false },
  { fieldId: "f-dept", pageId: "p1", label: "Dept. (main)", type: "multiple_choice", required: false, options: ["A", "B"] }, // a dot in the label
  { fieldId: "f-name", pageId: "p1", label: "Full name", type: "short_text", required: false },
  { fieldId: "f-note", pageId: "p1", label: "Notes", type: "long_text", required: false },
];

const mk = (answers: Record<string, any>, extra: Record<string, any> = {}) =>
  ResponseModel.create({ formId: form._id, answers, submittedAt: new Date("2026-09-27T12:00:00Z"), ...extra } as any);

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Workspace.init(), Membership.init(), Form.init(), ResponseModel.init(), FormAccessGrant.init()]);

  for (const n of ["owner", "admin", "editor", "reviewer", "viewer", "outsider", "solo", "other", "grantee"]) {
    U[n] = await User.create({ firebaseUid: `uid-cv2-${n}`, fullName: `${n} Person`, email: `${n}@cv2.test`, status: "active" });
    T[n] = generateToken({ id: U[n]._id.toString(), email: U[n].email, role: "user" });
  }
  wsA = await Workspace.create({ name: "Alpha", slug: "ws-a", owner: U.owner._id });
  wsB = await Workspace.create({ name: "Beta", slug: "ws-b", owner: U.outsider._id });
  await Membership.create([
    { userId: U.owner._id, workspaceId: wsA._id, role: "owner" },
    { userId: U.admin._id, workspaceId: wsA._id, role: "admin" },
    { userId: U.editor._id, workspaceId: wsA._id, role: "editor" },
    { userId: U.reviewer._id, workspaceId: wsA._id, role: "reviewer" },
    { userId: U.viewer._id, workspaceId: wsA._id, role: "viewer" },
    { userId: U.outsider._id, workspaceId: wsB._id, role: "owner" },
  ]);
  form = await Form.create({ title: "Intake", workspaceId: wsA._id, createdBy: U.owner._id, status: "draft", fields: fields(), pages: [{ id: "p1", order: 0, title: "P" }] } as any);
  personal = await Form.create({ title: "Mine", createdBy: U.solo._id, status: "draft", fields: fields(), pages: [{ id: "p1", order: 0, title: "P" }] } as any);
  await FormAccessGrant.create({ formId: personal._id, userId: U.grantee._id, role: "reviewer" });

  await mk({ Plan: "Pro", Features: ["Analytics", "Reports"], Rating: 5, "Start date": "2026-09-27", "Dept. (main)": "A", "Full name": "Ada" }, { assigneeId: U.editor._id });
  await mk({ Plan: " pro ", Features: ["analytics"], Rating: "3", "Start date": "2026-09-28", "Dept. (main)": "A" }, { submittedAt: new Date("2026-09-28T12:00:00Z"), assigneeId: U.editor._id });
  await mk({ Plan: "Free", Features: [], Rating: 5, "Start date": "2026-10-02T10:00:00Z", "Dept. (main)": "B" }, { submittedAt: new Date("2026-10-02T12:00:00Z") });
  await mk({ "f-plan": "Team", "f-feat": ["Reports"], "f-rate": 4, "f-when": "2026-10-15" }, { submittedAt: new Date("2026-10-15T12:00:00Z") }); // legacy fieldId keys
  await mk({ Plan: "Enterprise", Rating: "abc", "Start date": "garbage" }); // not an option / not a number / not a date
  await mk({}); // blank
  await mk({ Plan: "Team", Rating: 99 }, { isTest: true });
  await mk({ Plan: "Team", Rating: 99 }, { deletedAt: new Date() });
  await mk({ Plan: "Pro", Features: ["Reports"] }, { submittedAt: new Date("2026-09-27T13:00:00Z"), assigneeId: U.admin._id }); // r9 (answers a few)
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const agg = (fieldId: string, qs = "", who = "owner", f: any = form, slug: string | null = "ws-a") =>
  request(app).get(`/api/forms/${f._id}/analytics/field/${fieldId}${qs}`).set(as(who, slug));
const counts = (body: any) => Object.fromEntries(body.buckets.map((b: any) => [b.value, b.count]));

describe("GET /api/forms/:formId/analytics/field/:fieldId", () => {
  it("dropdown: per option in the field's own order, sloppy case/whitespace and fieldId-keyed answers counted, Other + blank reported", async () => {
    const r = await agg("f-plan");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, fieldId: "f-plan", fieldType: "dropdown", total: 6, blank: 1, totalResponses: 7 });
    expect(r.body.buckets.map((b: any) => [b.value, b.count, b.order])).toEqual([["Free", 1, 0], ["Pro", 3, 1], ["Team", 1, 2], ["__other__", 1, 3]]);
    expect(r.body.buckets[3]).toMatchObject({ label: "Other", other: true });
    expect(r.body.buckets[1].percentage).toBe(50); // 3 of the 6 who answered
  });

  it("checkbox: each selected option counts once per response; an empty array is blank", async () => {
    const r = await agg("f-feat");
    expect(counts(r.body)).toEqual({ Analytics: 2, Reports: 3 });
    expect(r.body).toMatchObject({ total: 4, blank: 3 });
    expect(r.body.buckets.map((b: any) => b.value)).toEqual(["Analytics", "Reports"]); // option order kept
  });

  it("multiple choice with a dot in its label", async () => {
    expect(counts((await agg("f-dept")).body)).toEqual({ A: 2, B: 1 });
  });

  it("number: distribution per value (strings that are numbers count, junk is blank) plus average/min/max", async () => {
    const r = await agg("f-rate");
    expect(r.body.buckets.map((b: any) => [b.value, b.count, b.order])).toEqual([["3", 1, 0], ["4", 1, 1], ["5", 2, 2]]);
    expect(r.body).toMatchObject({ total: 4, stats: { average: 4.25, min: 3, max: 5 } });
  });

  it("date: ISO bucket keys by day, week and month (UTC calendar values); unparseable dates are blank", async () => {
    expect(counts((await agg("f-when")).body)).toEqual({ "2026-09-27": 1, "2026-09-28": 1, "2026-10-02": 1, "2026-10-15": 1 });
    const week = await agg("f-when", "?granularity=week");
    expect(counts(week.body)).toEqual({ "2026-W39": 1, "2026-W40": 2, "2026-W42": 1 });
    expect(week.body.granularity).toBe("week");
    expect(counts((await agg("f-when", "?granularity=month")).body)).toEqual({ "2026-09": 2, "2026-10": 2 });
    expect((await agg("f-when", "?granularity=year")).status).toBe(400);
  });

  it("respects the date range (a date-only `to` runs to the end of that day) and excludes test + deleted unless includeTest", async () => {
    const r = await agg("f-plan", "?from=2026-09-28&to=2026-10-02");
    expect(counts(r.body)).toMatchObject({ Free: 1, Pro: 1, Team: 0 });
    const t = await agg("f-plan", "?includeTest=true");
    expect(counts(t.body).Team).toBe(2); // the test submission now counts; the soft-deleted one never does
  });

  it("long text, short text and unknown questions are refused", async () => {
    for (const id of ["f-note", "f-name"]) {
      const r = await agg(id);
      expect([r.status, r.body.error.code]).toEqual([400, "FIELD_NOT_CHARTABLE"]);
    }
    expect((await agg("nope")).status).toBe(404);
  });
});

describe("responses list filtered by field value == the aggregate", () => {
  const list = (qs: string, who = "owner") => request(app).get(`/api/responses?formId=${form._id}&${qs}`).set(as(who));

  it.each([
    ["f-plan", ""],
    ["f-feat", ""],
    ["f-dept", ""],
    ["f-rate", ""],
    ["f-when", "&granularity=day"],
    ["f-when", "&granularity=week"],
    ["f-when", "&granularity=month"],
  ])("every bucket of %s%s, and blank, has the same count in the panel", async (fieldId, g) => {
    const a = (await agg(fieldId, g.replace("&", "?"))).body;
    for (const b of a.buckets) {
      const l = await list(`field=${fieldId}&value=${encodeURIComponent(b.value)}${g}`);
      expect([fieldId, b.value, l.status, l.body.total]).toEqual([fieldId, b.value, 200, b.count]);
      expect(l.body.data).toHaveLength(Math.min(b.count, 10));
    }
    const blank = await list(`field=${fieldId}&value=__blank__${g}`);
    expect(blank.body.total).toBe(a.blank);
  });

  it("matches with pagination (server total stays the segment total), and combines with date range, assignee, stage, q and includeTest", async () => {
    const p2 = await list("field=f-plan&value=Pro&limit=2&page=2");
    expect(p2.body).toMatchObject({ total: 3, page: 2, limit: 2, totalPages: 2 });
    expect(p2.body.data).toHaveLength(1);

    const range = await list("field=f-plan&value=Pro&from=2026-09-28&to=2026-09-28");
    const aggRange = await agg("f-plan", "?from=2026-09-28&to=2026-09-28");
    expect([range.body.total, counts(aggRange.body).Pro]).toEqual([1, 1]);

    expect((await list(`field=f-plan&value=Pro&assigneeId=${U.editor._id}`)).body.total).toBe(2);
    expect((await list(`field=f-plan&value=Pro&assigneeId=unassigned`)).body.total).toBe(0);
    expect((await list(`field=f-plan&value=Pro&assigneeId=${U.admin._id}`)).body.total).toBe(1);
    expect((await list(`field=f-plan&value=__other__&q=enterprise`)).body.total).toBe(1);
    expect((await list(`field=f-plan&value=__other__&q=zzz-nothing`)).body.total).toBe(0);
    expect((await list(`field=f-plan&value=Team&includeTest=true`)).body.total).toBe(2);
    expect((await list(`field=f-plan&value=Team`)).body.total).toBe(1);
    const noStage = await list(`field=f-plan&value=Pro&stageId=${new mongoose.Types.ObjectId()}`);
    expect(noStage.body.total).toBe(0);
  });

  it("treats the value as a literal and rejects what it cannot use", async () => {
    for (const v of [".*", "^P", "Pro|Free", "$ne", "{\"$gt\":\"\"}", "Pro\\"]) {
      expect((await list(`field=f-plan&value=${encodeURIComponent(v)}`)).body.total).toBe(0);
    }
    const bad = async (qs: string) => (await list(qs));
    expect((await bad("field=f-plan")).status).toBe(400); // value missing
    expect((await bad("field=f-rate&value=abc")).body.error.code).toBe("INVALID_FILTER_VALUE");
    expect((await bad("field=f-when&value=2026-09&granularity=day")).status).toBe(400);
    expect((await bad("field=f-note&value=x")).body.error.code).toBe("FIELD_NOT_CHARTABLE");
    expect((await bad("field=zzz&value=x")).body.error.code).toBe("FIELD_NOT_FOUND");
    expect((await request(app).get("/api/responses?field=f-plan&value=Pro").set(as("owner"))).body.error.code).toBe("FIELD_FILTER_REQUIRES_FORM");
  });

  it("the filtered export is the same set (report filters carry field/value)", async () => {
    const rep = await ReportModel.create({ workspaceId: wsA._id, requestedBy: U.owner._id, format: "csv", expiresAt: new Date(Date.now() + 1e6), filters: { formId: String(form._id), field: "f-plan", value: "Pro" } } as any);
    expect(await countReportRows(rep)).toBe(3);
    const created = await request(app).post("/api/reports").set(as("owner")).send({ format: "csv", formId: String(form._id), field: "f-plan", value: "Pro" });
    expect(created.status).toBe(202);
    const bad = await request(app).post("/api/reports").set(as("owner")).send({ format: "csv", formId: String(form._id), field: "f-note", value: "x" });
    expect(bad.status).toBe(400);
  });
});

describe("permissions", () => {
  it("analytics:read roles read the aggregate and the filtered list; outsiders and other workspaces cannot", async () => {
    for (const who of ["owner", "admin", "editor", "reviewer", "viewer"]) {
      expect([who, (await agg("f-plan", "", who)).status]).toEqual([who, 200]);
    }
    expect((await agg("f-plan", "", "outsider", form, "ws-b")).status).toBe(403);
    expect((await agg("f-plan", "", "outsider", form, "ws-a")).status).toBe(403);
    expect((await agg("f-plan", "", "outsider", form, null)).status).toBe(403);
    expect((await request(app).get(`/api/forms/${form._id}/analytics/field/f-plan`)).status).toBe(401);
  });

  it("a personal form: its owner and a per-form grantee read it, another user does not", async () => {
    expect((await agg("f-plan", "", "solo", personal, "personal")).status).toBe(200);
    expect((await agg("f-plan", "", "grantee", personal, null)).status).toBe(200);
    expect((await agg("f-plan", "", "other", personal, "personal")).status).toBe(403);
    expect((await agg("f-plan", "", "other", personal, null)).status).toBe(403);
  });
});

describe("saved charts v2", () => {
  const url = (p = "") => `/api/forms/${form._id}/charts${p}`;
  const create = (who: string, body: any) => request(app).post(url()).set(as(who)).send(body);
  const ids = async (who: string) => (await request(app).get(url()).set(as(who))).body.charts.map((c: any) => c.title);
  beforeEach(async () => {
    await SavedChart.deleteMany({ formId: form._id });
  });

  it("validates the chart type per field type", async () => {
    const ok = (fieldId: string, chartType: string, extra: any = {}) => create("editor", { fieldId, chartType, ...extra });
    for (const t of ["pie", "donut", "bar", "hbar"]) expect((await ok("f-plan", t)).status).toBe(201);
    for (const t of ["bar", "line", "stat"]) expect((await ok("f-rate", t)).status).toBe(201);
    await SavedChart.deleteMany({ formId: form._id });
    for (const t of ["line", "area", "bar"]) expect((await ok("f-when", t, { granularity: "week" })).status).toBe(201);
    for (const [f, t] of [["f-plan", "line"], ["f-plan", "area"], ["f-plan", "stat"], ["f-feat", "line"], ["f-rate", "pie"], ["f-rate", "donut"], ["f-when", "pie"], ["f-when", "stat"], ["f-when", "hbar"], ["f-note", "bar"], ["nope", "bar"]]) {
      expect([f, t, (await ok(f, t)).status]).toEqual([f, t, 400]);
    }
    expect((await ok("f-plan", "bar", { title: "x".repeat(121) })).status).toBe(400);
    expect((await ok("f-plan", "bar", { size: "huge" })).status).toBe(400);
    const c = await ok("f-when", "line");
    expect(c.body.chart).toMatchObject({ granularity: "day", groupBy: "day", size: "medium", visibility: "private", options: { valueMode: "count", legend: true, sort: "order" }, title: "Start date", canEdit: true, isOwner: true, fieldMissing: false });
  });

  it("creating needs form edit rights (reviewer/viewer 403); reading needs analytics:read", async () => {
    expect((await create("reviewer", { fieldId: "f-plan", chartType: "bar" })).status).toBe(403);
    expect((await create("viewer", { fieldId: "f-plan", chartType: "bar" })).status).toBe(403);
    expect((await create("outsider", { fieldId: "f-plan", chartType: "bar" })).status).toBe(403);
    expect((await request(app).get(url()).set(as("outsider", "ws-b"))).status).toBe(403);
  });

  it("private by default: only the owner sees it; workspace-visible ones are readable by every analytics reader with canEdit false", async () => {
    await create("editor", { fieldId: "f-plan", chartType: "bar", title: "Mine" });
    const shared = await create("editor", { fieldId: "f-plan", chartType: "donut", title: "Shared", visibility: "workspace" });
    expect(await ids("editor")).toEqual(["Mine", "Shared"]);
    for (const who of ["owner", "admin", "reviewer", "viewer"]) expect([who, await ids(who)]).toEqual([who, ["Shared"]]);
    const viewerList = (await request(app).get(url()).set(as("viewer"))).body.charts;
    expect(viewerList[0]).toMatchObject({ canEdit: false, isOwner: false, ownerName: "editor Person" });
    const adminList = (await request(app).get(url()).set(as("admin"))).body.charts;
    expect(adminList[0].canEdit).toBe(true); // admins may edit workspace-visible charts

    // data follows the same visibility
    const priv = (await request(app).get(url()).set(as("editor"))).body.charts.find((c: any) => c.title === "Mine");
    expect((await request(app).get(url(`/${priv._id}/data`)).set(as("admin"))).status).toBe(404);
    expect((await request(app).get(url(`/${shared.body.chart._id}/data`)).set(as("viewer"))).status).toBe(200);
  });

  it("PATCH: owner edits size/title/options/visibility; a peer editor cannot touch a workspace chart (403) or see a private one (404); admin can edit a workspace one but not a private one", async () => {
    const mine = (await create("editor", { fieldId: "f-plan", chartType: "bar" })).body.chart;
    const p = await request(app).patch(url(`/${mine._id}`)).set(as("editor")).send({ size: "large", title: "Plans", options: { valueMode: "percent", sort: "value" }, visibility: "workspace" });
    expect(p.status).toBe(200);
    expect(p.body.chart).toMatchObject({ size: "large", title: "Plans", visibility: "workspace", options: { valueMode: "percent", legend: true, sort: "value" } });
    const peer = await create("admin", { fieldId: "f-plan", chartType: "pie", visibility: "private" });
    expect((await request(app).patch(url(`/${mine._id}`)).set(as("owner")).send({ title: "by owner" })).status).toBe(200); // owner role = admin+
    const otherEditor = await create("owner", { fieldId: "f-plan", chartType: "bar", visibility: "workspace" });
    expect((await request(app).patch(url(`/${otherEditor.body.chart._id}`)).set(as("editor")).send({ title: "no" })).status).toBe(403);
    expect((await request(app).delete(url(`/${otherEditor.body.chart._id}`)).set(as("editor"))).status).toBe(403);
    expect((await request(app).patch(url(`/${peer.body.chart._id}`)).set(as("owner")).send({ title: "no" })).status).toBe(404); // someone else's private chart
    expect((await request(app).patch(url(`/${mine._id}`)).set(as("editor")).send({ chartType: "line" })).status).toBe(400); // line on a dropdown
    expect((await request(app).patch(url(`/${mine._id}`)).set(as("viewer")).send({ title: "no" })).status).toBe(403); // route needs forms:write
  });

  it("reorder only touches the caller's own charts and 400s on foreign, unknown or repeated ids", async () => {
    const a = (await create("editor", { fieldId: "f-plan", chartType: "bar", title: "A" })).body.chart._id;
    await create("editor", { fieldId: "f-plan", chartType: "pie", title: "B" });
    const c = (await create("editor", { fieldId: "f-feat", chartType: "bar", title: "C" })).body.chart._id;
    const foreign = (await create("admin", { fieldId: "f-plan", chartType: "bar", title: "X", visibility: "workspace" })).body.chart._id;
    const put = (who: string, idList: string[]) => request(app).put(url("/order")).set(as(who)).send({ ids: idList });
    const ok = await put("editor", [c, a]); // b is left out: kept after the listed ones
    expect(ok.status).toBe(200);
    expect(ok.body.charts.filter((x: any) => x.isOwner).map((x: any) => x.title)).toEqual(["C", "A", "B"]);
    expect((await put("editor", [foreign])).body.error.code).toBe("FOREIGN_CHART_IDS");
    expect((await put("editor", [a, a])).status).toBe(400);
    expect((await put("editor", [String(new mongoose.Types.ObjectId())])).status).toBe(400);
    expect((await put("viewer", [a])).status).toBe(403);
    expect((await SavedChart.findById(foreign))!.position).toBe(0); // untouched
    expect(await ids("editor")).toEqual(["C", "A", "B", "X"]); // own first, then others' workspace charts
  });

  it("duplicate makes a private copy owned by the caller (also of a workspace chart they can see), undo = re-create", async () => {
    const src = (await create("owner", { fieldId: "f-plan", chartType: "donut", title: "Plans", size: "small", visibility: "workspace", options: { valueMode: "percent" } })).body.chart;
    const d = await request(app).post(url(`/${src._id}/duplicate`)).set(as("editor"));
    expect(d.status).toBe(201);
    expect(d.body.chart).toMatchObject({ title: "Plans (copy)", visibility: "private", size: "small", chartType: "donut", isOwner: true, options: { valueMode: "percent" } });
    expect(d.body.chart._id).not.toBe(src._id);
    expect(await ids("viewer")).toEqual(["Plans"]); // the copy is private
    const priv = (await create("owner", { fieldId: "f-plan", chartType: "bar" })).body.chart;
    expect((await request(app).post(url(`/${priv._id}/duplicate`)).set(as("editor"))).status).toBe(404);
    expect((await request(app).post(url(`/${src._id}/duplicate`)).set(as("viewer"))).status).toBe(403);
    expect((await request(app).delete(url(`/${d.body.chart._id}`)).set(as("editor"))).status).toBe(200);
    const again = await create("editor", { fieldId: src.fieldId, chartType: src.chartType, title: "Plans (copy)" });
    expect(again.status).toBe(201);
  });

  it("limits each person to 20 charts per form", async () => {
    for (let i = 0; i < 20; i++) expect((await create("editor", { fieldId: "f-plan", chartType: "bar" })).status).toBe(201);
    expect((await create("editor", { fieldId: "f-plan", chartType: "bar" })).body.error.code).toBe("CHART_LIMIT");
    expect((await create("owner", { fieldId: "f-plan", chartType: "bar" })).status).toBe(201); // per person
  });

  it("data returns the aggregate (and the legacy series), excludes test/deleted, flags a deleted question", async () => {
    const c = (await create("editor", { fieldId: "f-plan", chartType: "bar" })).body.chart;
    const d = await request(app).get(url(`/${c._id}/data`)).set(as("editor"));
    expect(d.body.series.map((s: any) => [s.label, s.value])).toEqual([["Free", 1], ["Pro", 3], ["Team", 1], ["Other", 1]]);
    expect(d.body.aggregate).toMatchObject({ total: 6, fieldId: "f-plan" });
    await Form.updateOne({ _id: form._id, "fields.fieldId": "f-plan" }, { $set: { "fields.$.deleted": true } });
    const after = await request(app).get(url()).set(as("editor"));
    expect(after.body.charts[0].fieldMissing).toBe(true);
    expect((await request(app).get(url(`/${c._id}/data`)).set(as("editor"))).body).toMatchObject({ fieldMissing: true, series: [], total: 0 });
    expect((await request(app).patch(url(`/${c._id}`)).set(as("editor")).send({ title: "still editable" })).status).toBe(200);
    await Form.updateOne({ _id: form._id, "fields.fieldId": "f-plan" }, { $set: { "fields.$.deleted": false } });
  });

  it("Sprint 14 clients keep working: groupBy accepted, charts they create are workspace-visible, responses carry groupBy/order", async () => {
    const made = await create("editor", { fieldId: "f-when", chartType: "line", groupBy: "week" });
    expect(made.status).toBe(201);
    expect(made.body.chart).toMatchObject({ groupBy: "week", granularity: "week", visibility: "workspace", order: 0, position: 0, fieldMissing: false });
    expect((await create("editor", { fieldId: "f-plan", chartType: "bar", groupBy: "day" })).status).toBe(400);
    expect((await create("editor", { fieldId: "f-when", chartType: "line", groupBy: "value" })).status).toBe(400);
    expect(await ids("viewer")).toEqual(["Start date"]);
    const patched = await request(app).patch(url(`/${made.body.chart._id}`)).set(as("editor")).send({ order: 3 });
    expect(patched.body.chart).toMatchObject({ order: 3, position: 3 });
    const prev = await request(app).post(url("/preview")).set(as("viewer")).send({ fieldId: "f-when", chartType: "line", groupBy: "day" });
    expect(prev.body.series).toHaveLength(4);
  });

  it("a raw Sprint 14 row (no v2 fields) reads as owner=createdBy, workspace, medium, position=order", async () => {
    const raw: any = await SavedChart.collection.insertOne({ formId: form._id, workspaceId: wsA._id, fieldId: "f-plan", chartType: "donut", groupBy: "value", createdBy: U.editor._id, order: 7, createdAt: new Date(), updatedAt: new Date() });
    const list = (await request(app).get(url()).set(as("viewer"))).body.charts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ _id: String(raw.insertedId), visibility: "workspace", size: "medium", position: 7, ownerId: String(U.editor._id), canEdit: false, granularity: null, title: "Plan" });
    expect((await request(app).get(url()).set(as("editor"))).body.charts[0].canEdit).toBe(true);
  });

  it("migrate:charts-v2 is idempotent, supports dry-run, and rolls back exactly what it wrote", async () => {
    await SavedChart.collection.insertMany([
      { formId: form._id, fieldId: "f-plan", chartType: "bar", groupBy: "value", createdBy: U.editor._id, order: 2, createdAt: new Date(), updatedAt: new Date() },
      { formId: form._id, fieldId: "f-when", chartType: "line", groupBy: "week", createdBy: U.owner._id, order: 0, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const native = (await create("editor", { fieldId: "f-plan", chartType: "pie", visibility: "private" })).body.chart._id;
    expect(await migrateChartsV2({ dryRun: true })).toMatchObject({ wouldMigrate: 2, migrated: 0 });
    expect(await SavedChart.collection.countDocuments({ _v2m: true })).toBe(0);
    expect(await migrateChartsV2()).toMatchObject({ migrated: 2 });
    expect(await migrateChartsV2()).toMatchObject({ migrated: 0 });
    const rows = await SavedChart.collection.find({ _v2m: true }).toArray();
    expect(rows.map((r: any) => [r.visibility, r.size, r.position, r.granularity, String(r.ownerId)]).sort()).toEqual(
      [["workspace", "medium", 0, "week", String(U.owner._id)], ["workspace", "medium", 2, null, String(U.editor._id)]].sort()
    );
    expect((await SavedChart.findById(native))!.visibility).toBe("private"); // native v2 rows are never touched
    expect((await request(app).get(url()).set(as("viewer"))).body.charts).toHaveLength(2);
    expect(await rollbackChartsV2()).toMatchObject({ rolledBack: 2 });
    const back: any = await SavedChart.collection.findOne({ fieldId: "f-when" });
    expect(back.ownerId).toBeUndefined();
    expect(String(back.createdBy)).toBe(String(U.owner._id)); // legacy fields untouched
    expect((await SavedChart.findById(native))!.visibility).toBe("private");
  });
});
