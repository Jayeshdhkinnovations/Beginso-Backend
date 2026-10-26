// Charts v3 query engine. The database answer (aggregation) is compared with a plain-code reference that loops over the same generated
// responses, for every kind of field, aggregation, filter and sort; the Responses list filtered by the same chart returns the same number
// of rows as the bar; and the fences (permissions, validation, cache, limits) hold.
process.env.JWT_SECRET = "test-jwt-secret-key-for-chart-query";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";
process.env.USER_RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import Stage from "../models/Stage";
import Tag from "../models/Tag";
import ResponseModel from "../models/Response";
import SavedChart from "../models/SavedChart";
import { generateToken } from "../utils/generateToken";
import { niceRanges, TOP_GROUPS } from "../utils/chartQuery";
import { resetChartCache, setMaxRunningForTests } from "../services/chartQuery.service";

const TZ = "Asia/Kolkata";
let mongo: MongoMemoryServer;
const T: Record<string, string> = {};
const U: Record<string, any> = {};
let ws: any, other: any, form: any, bigForm: any;
let stages: any = [];
let tags: any = [];
let rows: any[] = [];

const as = (who: string) => ({ Authorization: `Bearer ${T[who]}`, "x-workspace-slug": who === "outsider" ? "ws-b" : "ws-q" });
const query = (definition: any, who = "owner", f: any = form) => request(app).post(`/api/forms/${f._id}/charts/query`).set(as(who)).send({ definition });
const q = async (definition: any) => {
  const res = await query(definition);
  expect(res.status).toBe(200);
  return res.body;
};

// ── generated data (a small seeded generator, so a failure is reproducible) ──────────────────────────
let seed = 20261026;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const maybe = (p: number) => rnd() < p;

const FIELDS = [
  { fieldId: "f-drop", pageId: "p1", label: "Plan", type: "dropdown", options: ["Free", "Pro", "Team"] },
  { fieldId: "f-multi", pageId: "p1", label: "Features", type: "checkbox", options: ["Analytics", "Reports", "Exports"] },
  { fieldId: "f-yn", pageId: "p1", label: "Subscribed", type: "yes_no" },
  { fieldId: "f-rate", pageId: "p1", label: "Rating", type: "rating" },
  { fieldId: "f-num", pageId: "p1", label: "Age", type: "number" },
  { fieldId: "f-date", pageId: "p1", label: "Start date", type: "date" },
  { fieldId: "f-text", pageId: "p1", label: "Name", type: "short_text" },
  // two questions with the same label: their answers are kept apart ("Pick" and "Pick (2)")
  { fieldId: "f-pick1", pageId: "p1", label: "Pick", type: "dropdown", options: ["Red", "Blue"] },
  { fieldId: "f-pick2", pageId: "p1", label: "Pick", type: "dropdown", options: ["Red", "Blue", "Green"] },
];
const byId = (id: string) => FIELDS.find((f) => f.fieldId === id)!;
const keyOf = (id: string) => (id === "f-pick2" ? "Pick (2)" : byId(id).label);

const instants = [
  "2026-03-31T18:29:59Z", // 23:59:59 on 31 Mar in Kolkata
  "2026-03-31T18:30:00Z", // 00:00:00 on 1 Apr in Kolkata
  "2026-12-31T18:29:59Z",
  "2026-12-31T18:30:00Z", // 1 Jan 2027 in Kolkata
  "2026-10-24T05:00:00Z",
  "2026-10-25T20:00:00Z",
];

const makeAnswers = () => {
  const a: Record<string, any> = {};
  const put = (id: string, v: any) => {
    // half of the answers use the question's id as the key (older data), the rest its label
    a[maybe(0.3) ? id : keyOf(id)] = v;
  };
  if (maybe(0.85)) put("f-drop", pick([" pro ", "Free", "Team", "PRO", "Enterprise"]));
  if (maybe(0.7)) put("f-multi", Array.from(new Set([pick(["Analytics", "reports", "Exports"]), pick(["Analytics", "Exports", "Other thing"])])));
  if (maybe(0.7)) put("f-yn", pick(["Yes", "No"]));
  if (maybe(0.7)) put("f-rate", pick([1, 2, 3, 4, 5, "4"]));
  if (maybe(0.8)) put("f-num", pick([18, 22, 25, 25, 31, 40, 47, 59, "33", "abc", 72]));
  if (maybe(0.7)) put("f-date", pick(["2025-12-31", "2026-01-15", "2026-01-31", "2026-02-01", "2026-06-10", "garbage"]));
  if (maybe(0.5)) put("f-text", "someone");
  if (maybe(0.7)) put("f-pick1", pick(["Red", "Blue"]));
  if (maybe(0.7)) put("f-pick2", pick(["Red", "Blue", "Green"]));
  return a;
};

// ── the reference implementation (plain loops, no database) ──────────────────────────────────────────
const norm = (s: unknown) => String(s ?? "").trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
const read = (r: any, id: string) => {
  const f = byId(id);
  const v = f.fieldId === "f-pick2" ? r.answers["Pick (2)"] ?? r.answers[id] : r.answers[f.label] ?? r.answers[id];
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
};
const choiceVals = (r: any, id: string) => Array.from(new Set(read(r, id).map((x: any) => norm(x)).filter((x: string) => x !== "")));
const numVals = (r: any, id: string) =>
  Array.from(new Set(read(r, id).map((x: any) => (typeof x === "string" ? (x.trim() === "" ? NaN : Number(x.trim())) : Number(x))).filter((n: number) => Number.isFinite(n)))) as number[];
const options = (id: string) => (id === "f-yn" ? ["Yes", "No"] : (byId(id) as any).options);

const parts = (d: Date) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); // YYYY-MM-DD
  const [y, m, day] = f.split("-").map(Number);
  return { y, m, day };
};
const isoWeek = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return { y: date.getUTCFullYear(), w: Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7) };
};
const timeKey = (d: Date, bucket: string) => {
  const { y, m, day } = parts(d);
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (bucket === "year") return String(y);
  if (bucket === "month") return `${y}-${p2(m)}`;
  if (bucket === "day") return `${y}-${p2(m)}-${p2(day)}`;
  const w = isoWeek(y, m, day);
  return `${w.y}-W${p2(w.w)}`;
};
const dateKey = (r: any, bucket: string) => {
  const out = new Set<string>();
  for (const v of read(r, "f-date")) {
    const t = Date.parse(String(v).trim());
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    if (bucket === "year") out.add(String(y));
    else if (bucket === "month") out.add(`${y}-${p2(m)}`);
    else if (bucket === "day") out.add(`${y}-${p2(m)}-${p2(day)}`);
    else {
      const w = isoWeek(y, m, day);
      out.add(`${w.y}-W${p2(w.w)}`);
    }
  }
  return [...out];
};

const matches = (r: any, c: any): boolean => {
  const f = c.field;
  if (f.kind === "question") {
    const field: any = byId(f.fieldId);
    if (field.type === "dropdown" || field.type === "checkbox" || field.type === "yes_no") {
      const has = choiceVals(r, f.fieldId).includes(norm(c.value));
      return c.op === "is" ? has : !has;
    }
    const nums = numVals(r, f.fieldId);
    const n = Number(c.value);
    return cmp(nums, c.op, n);
  }
  if (f.key === "stage") return (String(r.stageId ?? "") === c.value) === (c.op === "is");
  if (f.key === "assignee") return (String(r.assigneeId ?? "") === c.value) === (c.op === "is");
  if (f.key === "tags") return (r.tagIds.map(String).includes(c.value)) === (c.op === "is");
  return cmp([parts(r.submittedAt).y], c.op, Number(c.value)); // submittedAt year
};
const cmp = (nums: number[], op: string, n: number) => {
  if (op === "eq") return nums.includes(n);
  if (op === "neq") return !nums.includes(n);
  const test: Record<string, (x: number) => boolean> = { gt: (x) => x > n, gte: (x) => x >= n, lt: (x) => x < n, lte: (x) => x <= n };
  return nums.some(test[op]);
};
const passes = (r: any, filters: any): boolean => {
  if (!filters || filters.items.length === 0) return true;
  const one = (i: any) => ("field" in i ? matches(r, i) : (i.op === "and" ? i.items.every((c: any) => matches(r, c)) : i.items.some((c: any) => matches(r, c))));
  return filters.op === "and" ? filters.items.every(one) : filters.items.some(one);
};

interface Ref {
  total: number;
  answered: number;
  groups: Map<string, { n: number; sum: number; cnt: number; min: number | null; max: number | null }>;
}
const measureOf = (r: any, m: any): number | null => {
  if (!m.field) return null;
  const v = numVals(r, m.field.fieldId);
  return v.length ? v[0] : null;
};
const reference = (def: any): Ref => {
  const rowsIn = rows.filter((r) => passes(r, def.filters));
  const g = def.groupBy.field;
  const bucket = def.groupBy.bucket ?? "month";
  let ranges: any = null;
  if (g.kind === "question" && byId(g.fieldId).type === "number") {
    const all = rowsIn.flatMap((r) => numVals(r, g.fieldId));
    ranges = all.length ? niceRanges(Math.min(...all), Math.max(...all)) : null;
  }
  const keysOf = (r: any): string[] => {
    if (g.kind === "system") {
      if (g.key === "stage") return r.stageId ? [String(r.stageId)] : [];
      if (g.key === "assignee") return r.assigneeId ? [String(r.assigneeId)] : [];
      if (g.key === "tags") return r.tagIds.map(String);
      return [timeKey(r.submittedAt, bucket)];
    }
    const t = (byId(g.fieldId) as any).type;
    if (t === "date") return dateKey(r, bucket);
    if (t === "number") return ranges ? Array.from(new Set(numVals(r, g.fieldId).map((x) => String(Math.floor((x - ranges.start) / ranges.step))))) : [];
    if (t === "rating") return numVals(r, g.fieldId).map(String);
    return choiceVals(r, g.fieldId);
  };
  const out: Ref = { total: rowsIn.length, answered: 0, groups: new Map() };
  for (const r of rowsIn) {
    const keys = keysOf(r);
    if (keys.length) out.answered += 1;
    const mv = measureOf(r, def.measure);
    for (const k of keys) {
      const x = out.groups.get(k) ?? { n: 0, sum: 0, cnt: 0, min: null, max: null };
      x.n += 1;
      if (mv !== null) {
        x.cnt += 1;
        x.sum += mv;
        x.min = x.min === null ? mv : Math.min(x.min, mv);
        x.max = x.max === null ? mv : Math.max(x.max, mv);
      }
      out.groups.set(k, x);
    }
  }
  return out;
};
const valueOf = (x: any, type: string) => (type === "count" ? x.n : type === "sum" ? Math.round(x.sum * 1e4) / 1e4 : type === "avg" ? (x.cnt ? Math.round((x.sum / x.cnt) * 1e4) / 1e4 : null) : type === "min" ? (x.cnt ? x.min : null) : x.cnt ? x.max : null);

// ── setup ────────────────────────────────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  for (const n of ["owner", "viewer", "outsider"]) {
    U[n] = await User.create({ firebaseUid: `uid-cq-${n}`, fullName: `${n} Person`, email: `${n}@cq.test`, status: "active" });
    T[n] = generateToken({ id: U[n]._id.toString(), email: U[n].email, role: "user" });
  }
  ws = await Workspace.create({ name: "Query WS", slug: "ws-q", owner: U.owner._id, timezone: TZ });
  other = await Workspace.create({ name: "Other WS", slug: "ws-b", owner: U.outsider._id });
  await Membership.create([
    { userId: U.owner._id, workspaceId: ws._id, role: "owner" },
    { userId: U.viewer._id, workspaceId: ws._id, role: "viewer" },
    { userId: U.outsider._id, workspaceId: other._id, role: "owner" },
  ]);
  stages = await Stage.create([
    { workspaceId: ws._id, name: "New", colour: "slate", order: 0, category: "new", isDefault: true },
    { workspaceId: ws._id, name: "Review", colour: "blue", order: 1, category: "in_progress", isDefault: false },
  ] as any);
  tags = await Tag.create([
    { workspaceId: ws._id, name: "VIP", nameLower: "vip", colour: "blue" },
    { workspaceId: ws._id, name: "Late", nameLower: "late", colour: "red" },
  ] as any);
  form = await Form.create({ title: "Chart form", workspaceId: ws._id, createdBy: U.owner._id, status: "published", fields: FIELDS, pages: [{ id: "p1", order: 0, title: "P" }] } as any);

  const docs: any[] = [];
  for (let i = 0; i < 320; i++) {
    docs.push({
      formId: form._id,
      answers: makeAnswers(),
      submittedAt: i < instants.length ? new Date(instants[i]) : new Date(Date.UTC(2026, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), Math.floor(rnd() * 60))),
      stageId: maybe(0.8) ? pick(stages as any[])._id : undefined,
      assigneeId: maybe(0.4) ? U.owner._id : undefined,
      tagIds: pick([[], [], [tags[0]._id], [tags[1]._id], [tags[0]._id, tags[1]._id]]),
    });
  }
  const created = await ResponseModel.create(docs);
  await ResponseModel.create([
    { formId: form._id, answers: { Plan: "Pro" }, isTest: true, submittedAt: new Date() }, // a test: never counted
    { formId: form._id, answers: { Plan: "Pro" }, deletedAt: new Date(), submittedAt: new Date() }, // trashed: never counted
  ] as any);
  rows = created.map((c: any) => c.toObject());

  // a form with 15 options, for "Showing top 12 of 15"
  bigForm = await Form.create({
    title: "Big",
    workspaceId: ws._id,
    createdBy: U.owner._id,
    status: "published",
    fields: [{ fieldId: "b-1", pageId: "p1", label: "Colour", type: "dropdown", options: Array.from({ length: 15 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`) }],
    pages: [{ id: "p1", order: 0, title: "P" }],
  } as any);
  await ResponseModel.create(Array.from({ length: 15 }, (_, i) => ({ formId: bigForm._id, answers: { Colour: `C${String(i + 1).padStart(2, "0")}` }, submittedAt: new Date() })) as any);
});
beforeEach(() => resetChartCache());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const question = (fieldId: string) => ({ kind: "question", fieldId });
const system = (key: string) => ({ kind: "system", key });
const simple = (groupField: any, extra: Record<string, any> = {}) => ({ kind: "simple", measure: { type: "count" }, groupBy: { field: groupField }, ...extra });

// compares the engine's groups with the reference's, key by key
const sameAsReference = async (def: any) => {
  const body = await q(def);
  const ref = reference(def);
  expect(body.total).toBe(ref.total);
  expect(body.answered).toBe(ref.answered);
  const got = new Map<string, any>(body.entries.map((e: any) => [e.focus?.key ?? e.key, e]));
  const g = def.groupBy.field;
  for (const [key, x] of ref.groups) {
    const v = valueOf(x, def.measure.type);
    if (v === null) continue;
    // find the entry: choice entries are filed under the option label, numbers under their range, the rest under the key itself
    const entry = body.entries.find((e: any) => {
      if (g.kind === "question" && ["dropdown", "checkbox", "yes_no"].includes((byId(g.fieldId) as any).type)) return norm(e.key) === key;
      if (g.kind === "question" && (byId(g.fieldId) as any).type === "number") return e.key === key;
      return e.key === key;
    });
    if (!entry && body.totalGroups > body.shown) continue; // a long list is cut to its top (or, for dates, latest) groups
    if (!entry) {
      // only a choice's "other" values (answers that are not one of its options) have no entry of their own
      expect(g.kind === "question" && ["dropdown", "checkbox", "yes_no"].includes((byId(g.fieldId) as any).type) && !options(g.fieldId).map(norm).includes(key)).toBe(true);
      continue;
    }
    expect({ key, value: entry.value, n: entry.n }).toEqual({ key, value: v, n: x.n });
  }
  expect(got.size).toBe(body.entries.length);
  return body;
};

// ── the tests ────────────────────────────────────────────────────────────────────────────────────────────
describe("the engine matches the reference implementation", () => {
  it.each([
    ["a dropdown", "f-drop"],
    ["a checkbox question (a respondent counts in every option they picked)", "f-multi"],
    ["a yes / no question", "f-yn"],
    ["a rating", "f-rate"],
    ["a number (five nice ranges)", "f-num"],
    ["a date question, by month", "f-date"],
    ["the first of two questions with the same label", "f-pick1"],
    ["the second of two questions with the same label", "f-pick2"],
  ])("groups by %s", async (_name, id) => {
    await sameAsReference(simple(question(id), { sort: "natural" }));
  });

  it.each(["day", "week", "month", "year"])("groups the submitted date by %s in the workspace time zone (midnight boundaries included)", async (bucket) => {
    const body = await sameAsReference(simple(system("submittedAt"), { groupBy: { field: system("submittedAt"), bucket }, sort: "natural" }));
    if (bucket === "month") {
      // 23:59:59 on 31 Mar in Kolkata is March; one second later is April
      const keys = body.entries.map((e: any) => e.key);
      expect(keys).toContain("2026-03");
      expect(keys).toContain("2026-04");
    }
    if (bucket === "year") expect(body.entries.map((e: any) => e.key)).toContain("2027"); // 1 Jan 2027 in Kolkata is still 31 Dec 2026 in UTC
  });

  it.each([["stage"], ["assignee"], ["tags"]])("groups by the response detail %s", async (key) => {
    await sameAsReference(simple(system(key), { sort: "natural" }));
  });

  it.each(["sum", "avg", "min", "max"])("%s of a number, per plan, ignoring blanks", async (type) => {
    const body = await sameAsReference({ kind: "simple", measure: { type, field: question("f-num") }, groupBy: { field: question("f-drop") }, sort: "natural" });
    expect(body.measureAnswered).toBeGreaterThan(0);
  });

  it("the average of a rating, per answer of a yes / no question", async () => {
    await sameAsReference({ kind: "simple", measure: { type: "avg", field: question("f-rate") }, groupBy: { field: question("f-yn") }, sort: "natural" });
  });

  it("never counts test responses or trashed ones", async () => {
    const body = await q(simple(question("f-drop")));
    expect(body.total).toBe(320);
  });
});

describe("filters", () => {
  const cond = (field: any, op: string, value: any) => ({ field, op, value });
  const cases: [string, any][] = [
    ["is", { op: "and", items: [cond(question("f-drop"), "is", "Pro")] }],
    ["is not", { op: "and", items: [cond(question("f-drop"), "is_not", "pro")] }],
    ["a checkbox option", { op: "and", items: [cond(question("f-multi"), "is", "Reports")] }],
    ["number >", { op: "and", items: [cond(question("f-num"), "gt", 25)] }],
    ["number >=", { op: "and", items: [cond(question("f-num"), "gte", 25)] }],
    ["number <", { op: "and", items: [cond(question("f-num"), "lt", 25)] }],
    ["number <=", { op: "and", items: [cond(question("f-num"), "lte", 25)] }],
    ["number =", { op: "and", items: [cond(question("f-num"), "eq", 25)] }],
    ["number not =", { op: "and", items: [cond(question("f-num"), "neq", 25)] }],
    ["rating >=", { op: "and", items: [cond(question("f-rate"), "gte", 4)] }],
    ["stage", { op: "and", items: [cond(system("stage"), "is", "STAGE0")] }],
    ["assignee", { op: "and", items: [cond(system("assignee"), "is_not", "OWNER")] }],
    ["tag", { op: "and", items: [cond(system("tags"), "is", "TAG0")] }],
    ["submitted year", { op: "and", items: [cond(system("submittedAt"), "eq", 2027)] }],
    ["AND of two", { op: "and", items: [cond(question("f-drop"), "is", "pro"), cond(question("f-num"), "gt", 30)] }],
    ["OR of two", { op: "or", items: [cond(question("f-drop"), "is", "free"), cond(question("f-yn"), "is", "yes")] }],
    ["AND with an OR group", { op: "and", items: [cond(question("f-num"), "gte", 22), { op: "or", items: [cond(question("f-drop"), "is", "free"), cond(question("f-drop"), "is", "team")] }] }],
    ["OR with an AND group", { op: "or", items: [cond(question("f-rate"), "lte", 2), { op: "and", items: [cond(question("f-yn"), "is", "no"), cond(question("f-pick1"), "is", "red")] }] }],
  ];
  const resolve = (f: any) => JSON.parse(JSON.stringify(f).replace("STAGE0", String(stages[0]._id)).replace("OWNER", String(U.owner._id)).replace("TAG0", String(tags[0]._id)));

  it.each(cases)("filter: %s agrees with the reference", async (_name, filters) => {
    await sameAsReference(simple(question("f-drop"), { filters: resolve(filters), sort: "natural" }));
  });

  it("the number on a bar is the number of rows the Responses list shows for the same chart and group", async () => {
    const def = simple(question("f-drop"), { filters: resolve(cases[14][1]) });
    const body = await q(def);
    for (const e of body.entries) {
      const res = await request(app).get(`/api/responses?formId=${form._id}&limit=1&chart=${encodeURIComponent(JSON.stringify({ definition: def, focus: e.focus }))}`).set(as("owner"));
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(e.n);
    }
    const all = await request(app).get(`/api/responses?formId=${form._id}&limit=1&chart=${encodeURIComponent(JSON.stringify({ definition: def }))}`).set(as("owner"));
    expect(all.body.total).toBe(body.total);
  });

  it("every kind of group (ranges, dates, stage, tags) opens exactly its own responses", async () => {
    for (const def of [simple(question("f-num")), simple(question("f-rate")), simple(system("submittedAt"), { groupBy: { field: system("submittedAt"), bucket: "month" } }), simple(system("stage")), simple(system("tags")), simple(question("f-multi"))]) {
      const body = await q(def);
      for (const e of body.entries) {
        const res = await request(app).get(`/api/responses?formId=${form._id}&limit=1&chart=${encodeURIComponent(JSON.stringify({ definition: def, focus: e.focus }))}`).set(as("owner"));
        expect({ label: e.label, rows: res.body.total }).toEqual({ label: e.label, rows: e.n });
      }
    }
  });

  it("a chart filter with an invalid definition is a 400, and a filter needs a form", async () => {
    const bad = await request(app).get(`/api/responses?formId=${form._id}&chart=${encodeURIComponent("{}")}`).set(as("owner"));
    expect(bad.status).toBe(400);
    const noForm = await request(app).get(`/api/responses?chart=${encodeURIComponent(JSON.stringify({ definition: simple(question("f-drop")) }))}`).set(as("owner"));
    expect(noForm.status).toBe(400);
  });
});

describe("sorting, limits and the blank line", () => {
  it("value high to low / low to high, name A to Z / Z to A, and the natural order", async () => {
    const desc = (await q(simple(question("f-drop"), { sort: "value_desc" }))).entries.filter((e: any) => e.key !== "__other__").map((e: any) => e.value);
    expect([...desc].sort((a, b) => b - a)).toEqual(desc);
    const asc = (await q(simple(question("f-drop"), { sort: "value_asc" }))).entries.filter((e: any) => e.key !== "__other__").map((e: any) => e.value);
    expect([...asc].sort((a, b) => a - b)).toEqual(asc);
    const az = (await q(simple(question("f-drop"), { sort: "label_asc" }))).entries.filter((e: any) => e.key !== "__other__").map((e: any) => e.label);
    expect([...az].sort((a, b) => a.localeCompare(b))).toEqual(az);
    const za = (await q(simple(question("f-drop"), { sort: "label_desc" }))).entries.filter((e: any) => e.key !== "__other__").map((e: any) => e.label);
    expect([...za].sort((a, b) => b.localeCompare(a))).toEqual(za);
    const natural = (await q(simple(question("f-drop"), { sort: "natural" }))).entries.map((e: any) => e.label);
    expect(natural.slice(0, 3)).toEqual(["Free", "Pro", "Team"]); // the question's own order; "Other" last
  });

  it("the default sort is high to low for a choice and the natural order for a number", async () => {
    const choice = (await q(simple(question("f-drop")))).entries.filter((e: any) => e.key !== "__other__").map((e: any) => e.value);
    expect([...choice].sort((a, b) => b - a)).toEqual(choice);
    const ratings = (await q(simple(question("f-rate")))).entries.filter((e: any) => e.key !== "__blank__").map((e: any) => Number(e.key));
    expect([...ratings].sort((a, b) => a - b)).toEqual(ratings);
  });

  it("shows the top 12 and says how many there are", async () => {
    const res = await query(simple(question("b-1")), "owner", bigForm);
    expect(res.status).toBe(200);
    expect(res.body.shown).toBe(TOP_GROUPS);
    expect(res.body.totalGroups).toBe(15);
    expect(res.body.warnings.map((w: any) => w.code)).toContain("top_groups");
  });

  it("answers the blank line: how many did not answer, in plain words, and 'Not scored' is a bar for a rating", async () => {
    const drop = await q(simple(question("f-drop")));
    expect(drop.blank).toBe(drop.total - drop.answered);
    expect(drop.entries.find((e: any) => e.key === "__blank__")).toBeUndefined();
    expect(drop.blankLabel).toBe("didn't answer");
    const rating = await q(simple(question("f-rate")));
    const notScored = rating.entries.find((e: any) => e.key === "__blank__");
    expect(notScored.label).toBe("Not scored");
    expect(notScored.n).toBe(rating.blank);
  });

  it("percent of respondents for a checkbox question can add up to more than 100", async () => {
    const body = await q(simple(question("f-multi")));
    const sum = body.entries.reduce((s: number, e: any) => s + e.share, 0);
    expect(sum).toBeGreaterThan(1);
  });

  it("number ranges are nice, cover every value, and a single value is one range", () => {
    expect(niceRanges(18, 72)).toEqual({ start: 0, step: 20, count: 4 });
    expect(niceRanges(5, 5)).toEqual({ start: 5, step: 1, count: 1 });
    const r = niceRanges(0, 100);
    expect(r.start + r.step * r.count).toBeGreaterThan(100);
  });
});

describe("saving, editing and the warnings", () => {
  const save = (definition: any, extra: Record<string, any> = {}, who = "owner") => request(app).post(`/api/forms/${form._id}/charts`).set(as(who)).send({ definition, ...extra });

  it("saves a chart with its definition, lists it, answers it, duplicates it, and 409s an out-of-date edit", async () => {
    const def = simple(question("f-drop"), { filters: { op: "and", items: [{ field: question("f-num"), op: "gt", value: 20 }] } });
    const created = await save(def, { title: "Plans over 20", chartType: "auto", size: "large" });
    expect(created.status).toBe(201);
    expect(created.body.chart).toMatchObject({ kind: "simple", chartType: "auto", size: "large", visibility: "private", title: "Plans over 20", version: 1 });
    const id = created.body.chart._id;

    const list = await request(app).get(`/api/forms/${form._id}/charts`).set(as("owner"));
    expect(list.body.charts.find((c: any) => c._id === id).definition.groupBy.field.fieldId).toBe("f-drop");

    const data = await request(app).get(`/api/forms/${form._id}/charts/${id}/data`).set(as("owner"));
    expect(data.status).toBe(200);
    expect(data.body.query.total).toBeGreaterThan(0);

    const dup = await request(app).post(`/api/forms/${form._id}/charts/${id}/duplicate`).set(as("owner"));
    expect(dup.body.chart.definition.groupBy.field.fieldId).toBe("f-drop");
    expect(dup.body.chart.title).toBe("Plans over 20 (copy)");

    const ok = await request(app).patch(`/api/forms/${form._id}/charts/${id}`).set(as("owner")).send({ expectedVersion: 1, definition: simple(question("f-yn")), title: "Subscribed" });
    expect(ok.status).toBe(200);
    expect(ok.body.chart.version).toBe(2);
    const stale = await request(app).patch(`/api/forms/${form._id}/charts/${id}`).set(as("owner")).send({ expectedVersion: 1, title: "Late edit" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("CHART_VERSION_CONFLICT");
  });

  it("a chart whose question was removed answers 200 with a warning, never a 500", async () => {
    const f2 = await Form.create({ title: "Temp", workspaceId: ws._id, createdBy: U.owner._id, status: "published", fields: [{ fieldId: "t-1", pageId: "p1", label: "Mood", type: "dropdown", options: ["Good", "Bad"] }], pages: [{ id: "p1", order: 0, title: "P" }] } as any);
    const created = await request(app).post(`/api/forms/${f2._id}/charts`).set(as("owner")).send({ definition: simple(question("t-1")), chartType: "auto" });
    expect(created.status).toBe(201);
    await Form.updateOne({ _id: f2._id }, { $set: { "fields.0.deleted": true } });
    const data = await request(app).get(`/api/forms/${f2._id}/charts/${created.body.chart._id}/data`).set(as("owner"));
    expect(data.status).toBe(200);
    expect(data.body.query.warnings[0].code).toBe("field_removed");
    expect(data.body.query.entries).toEqual([]);
    const list = await request(app).get(`/api/forms/${f2._id}/charts`).set(as("owner"));
    expect(list.body.charts[0].fieldMissing).toBe(true);
  });

  it("at most 24 charts per form per person", async () => {
    const f3 = await Form.create({ title: "Many", workspaceId: ws._id, createdBy: U.owner._id, status: "published", fields: [{ fieldId: "m-1", pageId: "p1", label: "A", type: "dropdown", options: ["x"] }], pages: [{ id: "p1", order: 0, title: "P" }] } as any);
    await SavedChart.insertMany(Array.from({ length: 24 }, (_, i) => ({ formId: f3._id, fieldId: "m-1", chartType: "bar", ownerId: U.owner._id, createdBy: U.owner._id, visibility: "private", position: i, order: i })));
    const res = await request(app).post(`/api/forms/${f3._id}/charts`).set(as("owner")).send({ definition: simple(question("m-1")) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CHART_LIMIT");
  });
});

describe("validation and permissions", () => {
  const bad = async (definition: any, who = "owner") => (await query(definition, who)).status;

  it("rejects what cannot be charted, with a 400", async () => {
    expect(await bad(simple(question("nope")))).toBe(400); // not on the form
    expect(await bad(simple(question("f-text")))).toBe(400); // short text is not offered
    expect(await bad({ ...simple(question("f-drop")), groupBy: { field: question("f-drop"), bucket: "month" } })).toBe(400); // bucket on a non-date
    expect(await bad({ kind: "simple", measure: { type: "sum" }, groupBy: { field: question("f-drop") } })).toBe(400); // sum needs a field
    expect(await bad({ kind: "simple", measure: { type: "sum", field: question("f-drop") }, groupBy: { field: question("f-yn") } })).toBe(400); // sum of a dropdown
    expect(await bad({ kind: "simple", measure: { type: "count", field: question("f-num") }, groupBy: { field: question("f-yn") } })).toBe(400);
    expect(await bad(simple(question("f-drop"), { filters: { op: "and", items: [{ field: question("f-drop"), op: "gt", value: 3 }] } }))).toBe(400); // comparison on a choice
    expect(await bad(simple(question("f-drop"), { filters: { op: "and", items: [{ field: question("f-num"), op: "is", value: "x" }] } }))).toBe(400); // "is" on a number
    expect(await bad(simple(question("f-drop"), { filters: { op: "and", items: [{ field: question("f-date"), op: "eq", value: 2026 }] } }))).toBe(400); // a date question: by submitted year only
    expect(await bad(simple(question("f-drop"), { sort: "sideways" }))).toBe(400);
    expect(await bad({ kind: "drilldown", groupBy: { field: question("f-drop") } })).toBe(400); // drill-down is not built yet
    const nine = Array.from({ length: 9 }, () => ({ field: question("f-num"), op: "gt", value: 1 }));
    expect(await bad(simple(question("f-drop"), { filters: { op: "and", items: nine } }))).toBe(400);
  });

  it("a stranger and a signed-out caller cannot read a chart; a viewer can read but not save", async () => {
    expect((await query(simple(question("f-drop")), "outsider")).status).toBeGreaterThanOrEqual(403);
    const anon = await request(app).post(`/api/forms/${form._id}/charts/query`).send({ definition: simple(question("f-drop")) });
    expect(anon.status).toBe(401);
    expect((await query(simple(question("f-drop")), "viewer")).status).toBe(200);
    const save = await request(app).post(`/api/forms/${form._id}/charts`).set(as("viewer")).send({ definition: simple(question("f-drop")) });
    expect(save.status).toBe(403);
  });

  it("never puts an answer, an email or an address in the payload", async () => {
    const body = JSON.stringify(await q(simple(question("f-text")).groupBy ? simple(question("f-drop")) : null));
    expect(body).not.toMatch(/@/);
    expect(body).not.toMatch(/someone/);
  });
});

describe("the fences: cache and concurrency", () => {
  it("serves a repeat from the cache, and recomputes when a response arrives", async () => {
    const def = simple(question("f-drop"));
    const first = await q(def);
    const second = await q(def);
    expect(second.computedAt).toBe(first.computedAt);
    await ResponseModel.create({ formId: form._id, answers: { Plan: "Pro" }, submittedAt: new Date() } as any);
    const third = await q(def);
    expect(third.computedAt).not.toBe(first.computedAt);
    expect(third.total).toBe(first.total + 1);
    await ResponseModel.deleteOne({ formId: form._id, answers: { Plan: "Pro" }, submittedAt: { $gt: new Date(Date.now() - 60000) } });
  });

  it("how a chart looks (palette, labels) does not change its cache key", async () => {
    const a = await q(simple(question("f-yn"), { display: { palette: "ocean" } }));
    const b = await q(simple(question("f-yn"), { display: { palette: "forest", dataLabels: true } }));
    expect(b.computedAt).toBe(a.computedAt);
  });

  it("when too many charts are running, the next one gets a 429 with a retry hint", async () => {
    setMaxRunningForTests(0);
    const res = await query(simple(question("f-drop")));
    setMaxRunningForTests(4);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.body.error.code).toBe("CHART_BUSY");
  });
});

describe("speed on the seeded size", () => {
  it("a plain and a filtered query over 1,170 responses stay well under the 1.5 s budget", async () => {
    const big = await Form.create({ title: "Seeded", workspaceId: ws._id, createdBy: U.owner._id, status: "published", fields: FIELDS, pages: [{ id: "p1", order: 0, title: "P" }] } as any);
    await ResponseModel.insertMany(Array.from({ length: 1170 }, () => ({ formId: big._id, answers: makeAnswers(), submittedAt: new Date(Date.UTC(2026, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28))), tagIds: [] })));
    const times: number[] = [];
    for (const def of [simple(question("f-drop")), simple(question("f-num")), simple(system("submittedAt")), simple(question("f-drop"), { filters: { op: "and", items: [{ field: question("f-num"), op: "gt", value: 25 }, { op: "or", items: [{ field: question("f-yn"), op: "is", value: "yes" }, { field: question("f-rate"), op: "gte", value: 4 }] }] } })]) {
      const t0 = Date.now();
      const res = await query(def, "owner", big);
      times.push(Date.now() - t0);
      expect(res.status).toBe(200);
    }
    const p95 = [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];
    console.log(`chart query ms on 1,170 responses: ${times.join(", ")} (p95 ${p95})`);
    expect(p95).toBeLessThan(1500);
  });
});
