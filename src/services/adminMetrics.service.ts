import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";
import Template from "../models/Template";
import ReportModel from "../models/Report";
import SessionModel from "../models/Session";
import UserActivity from "../models/UserActivity";
import { getAuth } from "firebase-admin/auth";
import { computeCompletionRate } from "../utils/completionRate";
import { SystemLog } from "../models/SystemLog";
import { MailLog } from "../models/MailLog";
import { cachedFor } from "../utils/ttlCache";
import { denseSeries, resolveRange, type MetricsRange } from "../utils/metricsRange";

// Read-only platform metrics for the super admin console (Insights and Overview). Every figure is an aggregation or an indexed count: no
// collection is loaded into memory. Dates are UTC and ranges include the end day. Each result is cached for 60 seconds per range, and
// carries `computedAt` so the console can say how old it is. Definitions are in the comments of this file.
//
// Privacy: counts, ids and names of workspaces and forms only. No passwords, tokens, IPs, answers or respondent emails.

const CACHE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MetricsInput {
  from?: string;
  to?: string;
  compare?: boolean;
  refresh?: boolean;
}

export interface MetricsMeta {
  from: string;
  to: string;
  days: number;
  previous: { from: string; to: string } | null;
  timezone: "UTC";
  computedAt: string;
  cached: boolean;
}

const dayOf = (field: string) => ({ $dateToString: { format: "%Y-%m-%d", date: `$${field}`, timezone: "UTC" } });
const between = (field: string, from: Date, to: Date) => ({ [field]: { $gte: from, $lte: to } });
const ADMINS = { role: "admin" } as const;

/** Rows grouped by day ({ _id: "YYYY-MM-DD", n }) for a collection, as one number per day. */
async function perDay(model: any, field: string, from: Date, to: Date, dayKeys: string[], extra: Record<string, unknown> = {}): Promise<number[]> {
  const rows = await model.aggregate([{ $match: { ...between(field, from, to), ...extra } }, { $group: { _id: dayOf(field), n: { $sum: 1 } } }]);
  return denseSeries(dayKeys, rows);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Distinct users with a session last active inside the window. Exact for a window that ends now (see docs: lastActiveAt keeps only the latest). */
async function activeUsersIn(from: Date, to: Date): Promise<number> {
  const rows = await SessionModel.aggregate([
    { $match: between("lastActiveAt", from, to) },
    { $group: { _id: "$userId" } },
    { $lookup: { from: User.collection.name, localField: "_id", foreignField: "_id", as: "u", pipeline: [{ $match: ADMINS }, { $project: { _id: 1 } }] } },
    { $match: { "u.0": { $exists: true } } },
    { $count: "n" },
  ]);
  return rows[0]?.n ?? 0;
}

async function topFormsAndWorkspaces(from: Date, to: Date, limit: number) {
  const perForm = [
    { $match: { ...between("submittedAt", from, to), deletedAt: null } },
    { $group: { _id: "$formId", n: { $sum: 1 } } },
  ];
  const formLookup = {
    $lookup: { from: Form.collection.name, localField: "_id", foreignField: "_id", as: "f", pipeline: [{ $match: { deletedAt: null } }, { $project: { workspaceId: 1, title: 1 } }] },
  };

  const [workspaces, forms] = await Promise.all([
    ResponseModel.aggregate([
      ...perForm,
      formLookup,
      { $unwind: "$f" },
      { $group: { _id: "$f.workspaceId", n: { $sum: "$n" }, forms: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: limit },
      { $lookup: { from: Workspace.collection.name, localField: "_id", foreignField: "_id", as: "w", pipeline: [{ $project: { name: 1 } }] } },
      { $project: { _id: 0, id: { $toString: "$_id" }, name: { $ifNull: [{ $arrayElemAt: ["$w.name", 0] }, null] }, responses: "$n", forms: 1 } },
    ]),
    ResponseModel.aggregate([
      ...perForm,
      { $sort: { n: -1 } },
      { $limit: limit },
      formLookup,
      { $unwind: "$f" },
      { $lookup: { from: Workspace.collection.name, localField: "f.workspaceId", foreignField: "_id", as: "w", pipeline: [{ $project: { name: 1 } }] } },
      { $project: { _id: 0, id: { $toString: "$_id" }, title: "$f.title", workspace: { $ifNull: [{ $arrayElemAt: ["$w.name", 0] }, null] }, responses: "$n" } },
      { $sort: { responses: -1 } },
    ]),
  ]);
  return { workspaces, forms };
}

const UNKNOWN = (reason: string) => ({ available: false as const, reason });

function finish<T>(range: MetricsRange, data: T, c: { computedAt: string; cached: boolean }) {
  const meta: MetricsMeta = {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    days: range.days,
    previous: range.previous ? { from: range.previous.from.toISOString(), to: range.previous.to.toISOString() } : null,
    timezone: "UTC",
    computedAt: c.computedAt,
    cached: c.cached,
  };
  return { data, meta };
}

function run<T>(name: string, input: MetricsInput, compute: (range: MetricsRange) => Promise<T>) {
  const range = resolveRange(input);
  const key = `${name}:${range.from.toISOString()}:${range.to.toISOString()}:${range.previous ? "c" : "n"}`;
  return cachedFor(key, CACHE_MS, () => compute(range), !!input.refresh).then((c) => finish(range, c.value, c));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Overview: the KPI row, the main chart and the top workspaces.
// ---------------------------------------------------------------------------------------------------------------------------------
export function getOverviewMetrics(input: MetricsInput) {
  return run("overview", input, async (range) => {
    const now = new Date();
    const prev = range.previous;
    const [
      usersByStatus, registrations, prevRegistrations, workspaces, forms, publishedForms, responsesTotal, storage,
      responsesDaily, prevResponsesDaily, active30, top,
    ] = await Promise.all([
      User.aggregate([{ $match: ADMINS }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      perDay(User, "createdAt", range.from, range.to, range.dayKeys, ADMINS),
      prev ? perDay(User, "createdAt", prev.from, prev.to, prev.dayKeys, ADMINS) : Promise.resolve(null),
      Workspace.estimatedDocumentCount(),
      Form.countDocuments({}),
      Form.countDocuments({ status: "published" }),
      ResponseModel.countDocuments({ deletedAt: null }),
      User.aggregate([{ $match: ADMINS }, { $group: { _id: null, bytes: { $sum: "$storageUsedBytes" } } }]),
      perDay(ResponseModel, "submittedAt", range.from, range.to, range.dayKeys, { deletedAt: null }),
      prev ? perDay(ResponseModel, "submittedAt", prev.from, prev.to, prev.dayKeys, { deletedAt: null }) : Promise.resolve(null),
      activeUsersIn(new Date(now.getTime() - 30 * DAY_MS), now),
      topFormsAndWorkspaces(range.from, range.to, 5),
    ]);

    const statusCount = (s: string) => usersByStatus.find((r: any) => r._id === s)?.n ?? 0;
    const registrationsTotal = sum(registrations);
    const responsesInRange = sum(responsesDaily);

    return {
      kpis: {
        totalUsers: { value: statusCount("active") + statusCount("suspended"), suspended: statusCount("suspended") },
        // Last 30 days up to now, whatever range was asked for (the definition is in the comment above).
        activeUsers30d: { value: active30, previous: UNKNOWN("Sessions keep only their last activity, so an earlier window cannot be rebuilt.") },
        newRegistrations: { value: registrationsTotal, previous: prevRegistrations ? sum(prevRegistrations) : null },
        workspaces: { value: workspaces },
        totalForms: { value: forms, published: publishedForms },
        totalResponses: { value: responsesTotal },
        responsesInRange: { value: responsesInRange, previous: prevResponsesDaily ? sum(prevResponsesDaily) : null },
        storageUsedBytes: { value: storage[0]?.bytes ?? 0 },
      },
      series: {
        days: range.dayKeys,
        registrations: { current: registrations, previous: prevRegistrations },
        responses: { current: responsesDaily, previous: prevResponsesDaily },
      },
      topWorkspacesByResponses: top.workspaces,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------------------------------------------------------------
/** Email verification lives in Firebase, not in the database: ask it about every registered account, 100 at a time (its limit). */
// ponytail: one Firebase call per 100 users, cached 60 s with the rest; store an emailVerified field when that gets slow.
async function verifiedSplit() {
  const users = await User.find(ADMINS).select("firebaseUid").lean();
  const ids = users.map((u: any) => u.firebaseUid).filter(Boolean) as string[];
  try {
    let verified = 0;
    let unverified = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const found = await getAuth().getUsers(ids.slice(i, i + 100).map((uid) => ({ uid })));
      for (const account of found.users) {
        if (account.emailVerified) verified += 1;
        else unverified += 1;
      }
    }
    // `unknown`: accounts in the database that Firebase has no record of.
    return { available: true as const, verified, unverified, unknown: users.length - verified - unverified };
  } catch {
    return UNKNOWN("Firebase did not answer, so email verification cannot be shown right now.");
  }
}

export function getGrowthMetrics(input: MetricsInput) {
  return run("growth", input, async (range) => {
    const [registrations, usersBefore, workspacesDaily, formsDaily, workspacesBefore, formsBefore, verification] = await Promise.all([
      perDay(User, "createdAt", range.from, range.to, range.dayKeys, ADMINS),
      User.countDocuments({ ...ADMINS, createdAt: { $lt: range.from } }),
      perDay(Workspace, "createdAt", range.from, range.to, range.dayKeys),
      perDay(Form, "createdAt", range.from, range.to, range.dayKeys, { deletedAt: null }),
      Workspace.countDocuments({ createdAt: { $lt: range.from } }),
      Form.countDocuments({ createdAt: { $lt: range.from } }),
      verifiedSplit(),
    ]);
    const running = (start: number, daily: number[]) => daily.reduce<number[]>((acc, n) => [...acc, (acc[acc.length - 1] ?? start) + n], []);

    return {
      days: range.dayKeys,
      registrations,
      cumulativeUsers: running(usersBefore, registrations),
      workspacesCreated: workspacesDaily,
      cumulativeWorkspaces: running(workspacesBefore, workspacesDaily),
      formsCreated: formsDaily,
      cumulativeForms: running(formsBefore, formsDaily),
      verifiedVsUnverified: verification,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------------------------------------------------------------
export function getEngagementMetrics(input: MetricsInput) {
  return run("engagement", input, async (range) => {
    const now = new Date();
    const [dau, wau, mau, activeRows, publishedNow, totalNow, publishedDaily, responseHeat, sessionHeat, activeSeries] = await Promise.all([
      activeUsersIn(new Date(now.getTime() - DAY_MS), now),
      activeUsersIn(new Date(now.getTime() - 7 * DAY_MS), now),
      activeUsersIn(new Date(now.getTime() - 30 * DAY_MS), now),
      // Active users in the range, split by whether they registered before the range started.
      SessionModel.aggregate([
        { $match: between("lastActiveAt", range.from, range.to) },
        { $group: { _id: "$userId" } },
        { $lookup: { from: User.collection.name, localField: "_id", foreignField: "_id", as: "u", pipeline: [{ $match: ADMINS }, { $project: { createdAt: 1 } }] } },
        { $unwind: "$u" },
        { $group: { _id: { $cond: [{ $lt: ["$u.createdAt", range.from] }, "returning", "new"] }, n: { $sum: 1 } } },
      ]),
      Form.countDocuments({ status: "published" }),
      Form.countDocuments({}),
      perDay(Form, "publishedAt", range.from, range.to, range.dayKeys, { deletedAt: null }),
      heatmap(ResponseModel, "submittedAt", range, { deletedAt: null }),
      heatmap(SessionModel, "lastActiveAt", range),
      activeUsersPerDay(range),
    ]);
    const split = (k: string) => activeRows.find((r: any) => r._id === k)?.n ?? 0;

    return {
      days: range.dayKeys,
      activeUsers: {
        daily: dau,
        weekly: wau,
        monthly: mau,
        definition: "Distinct admin accounts with a session whose last activity falls in the window, counted back from now. A revoked session still counts.",
        series: activeSeries,
      },
      newVsReturning: { new: split("new"), returning: split("returning"), approximate: true },
      heatmap: { responses: responseHeat, adminActivity: sessionHeat, rows: "Mon..Sun", columns: "hour 0..23 UTC" },
      publishRate: {
        publishedForms: publishedNow,
        totalForms: totalNow,
        rate: totalNow > 0 ? publishedNow / totalNow : null,
        // Form.publishedAt holds the latest publish only: an unpublish and republish overwrites it.
        publishedPerDay: { values: publishedDaily, note: "Counts each form's latest publish." },
      },
    };
  });
}

/** Distinct registered users per UTC day, from the daily activity rows (see models/UserActivity). */
async function activeUsersPerDay(range: MetricsRange) {
  const [first, rows] = await Promise.all([
    UserActivity.findOne().sort({ day: 1 }).select("day").lean(),
    UserActivity.aggregate([
      { $match: between("day", range.from, range.to) },
      { $lookup: { from: User.collection.name, localField: "userId", foreignField: "_id", as: "u", pipeline: [{ $match: ADMINS }, { $project: { _id: 1 } }] } },
      { $match: { "u.0": { $exists: true } } },
      { $group: { _id: dayOf("day"), n: { $sum: 1 } } },
    ]),
  ]);
  if (!first) return UNKNOWN("Daily activity has only just started being recorded. The chart fills in from today.");
  // Days before `since` were never recorded: their zeros mean "not counted", not "nobody".
  return { available: true as const, since: (first as any).day.toISOString().slice(0, 10), values: denseSeries(range.dayKeys, rows) };
}

/** 7 x 24 counts, Monday first, hours in UTC. */
async function heatmap(model: any, field: string, range: MetricsRange, extra: Record<string, unknown> = {}): Promise<number[][]> {
  const rows = await model.aggregate([
    { $match: { ...between(field, range.from, range.to), ...extra } },
    { $group: { _id: { d: { $dayOfWeek: { date: `$${field}`, timezone: "UTC" } }, h: { $hour: { date: `$${field}`, timezone: "UTC" } } }, n: { $sum: 1 } } },
  ]);
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const r of rows) {
    // $dayOfWeek: 1 = Sunday .. 7 = Saturday. Row 0 = Monday.
    grid[(r._id.d + 5) % 7][r._id.h] = r.n;
  }
  return grid;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------------------------------------------
/**
 * Responses divided by counted views, over live forms whose view count covers all their responses. A form with more responses
 * than views collected some before views were counted, so it is left out rather than pushing the rate past 100%.
 */
async function platformCompletionRate() {
  const [row] = await Form.aggregate([
    { $match: { deletedAt: null, viewsCount: { $gt: 0 } } },
    { $lookup: { from: ResponseModel.collection.name, localField: "_id", foreignField: "formId", as: "r", pipeline: [{ $match: { deletedAt: null, isTest: { $ne: true } } }, { $count: "n" }] } },
    { $project: { views: "$viewsCount", submissions: { $ifNull: [{ $arrayElemAt: ["$r.n", 0] }, 0] } } },
    { $match: { $expr: { $lte: ["$submissions", "$views"] } } },
    { $group: { _id: null, views: { $sum: "$views" }, submissions: { $sum: "$submissions" }, forms: { $sum: 1 } } },
  ]);
  if (!row) return UNKNOWN("No form views have been recorded yet.");
  return { available: true as const, value: computeCompletionRate(row.submissions, row.views) as number, views: row.views, submissions: row.submissions, forms: row.forms };
}

export function getUsageMetrics(input: MetricsInput) {
  return run("usage", input, async (range) => {
    const [responsesDaily, totalForms, responsesTotal, top, uploadRows, bytesBefore, exportRows, templateTop, templateFormsInRange, templateFormsTotal, completion] =
      await Promise.all([
        perDay(ResponseModel, "submittedAt", range.from, range.to, range.dayKeys, { deletedAt: null }),
        Form.countDocuments({}),
        ResponseModel.countDocuments({ deletedAt: null }),
        topFormsAndWorkspaces(range.from, range.to, 10),
        Upload.aggregate([
          { $match: between("createdAt", range.from, range.to) },
          { $group: { _id: dayOf("createdAt"), n: { $sum: 1 }, bytes: { $sum: "$size" } } },
        ]),
        Upload.aggregate([{ $match: { createdAt: { $lt: range.from } } }, { $group: { _id: null, bytes: { $sum: "$size" } } }]),
        ReportModel.aggregate([
          { $match: between("createdAt", range.from, range.to) },
          { $group: { _id: { day: dayOf("createdAt"), format: "$format", failed: { $eq: ["$status", "failed"] } }, n: { $sum: 1 } } },
        ]),
        Form.aggregate([
          { $match: { deletedAt: null, templateId: { $ne: null } } },
          { $group: { _id: "$templateId", n: { $sum: 1 } } },
          { $sort: { n: -1 } },
          { $limit: 10 },
          { $lookup: { from: Template.collection.name, localField: "_id", foreignField: "_id", as: "t", pipeline: [{ $project: { name: 1 } }] } },
          { $project: { _id: 0, id: { $toString: "$_id" }, name: { $ifNull: [{ $arrayElemAt: ["$t.name", 0] }, null] }, forms: "$n" } },
        ]),
        Form.countDocuments({ ...between("createdAt", range.from, range.to), templateId: { $ne: null } }),
        Form.countDocuments({ templateId: { $ne: null } }),
        platformCompletionRate(),
      ]);

    const uploadCount = denseSeries(range.dayKeys, uploadRows.map((r: any) => ({ _id: r._id, n: r.n })));
    const uploadBytes = denseSeries(range.dayKeys, uploadRows.map((r: any) => ({ _id: r._id, n: r.bytes })));
    const exportsBy = (format: string) =>
      denseSeries(range.dayKeys, aggregateRows(exportRows.filter((r: any) => r._id.format === format)));
    const exportsFailed = denseSeries(range.dayKeys, aggregateRows(exportRows.filter((r: any) => r._id.failed)));

    let acc = bytesBefore[0]?.bytes ?? 0;
    const cumulativeBytes = uploadBytes.map((b) => (acc += b));

    return {
      days: range.dayKeys,
      responsesPerDay: responsesDaily,
      averageResponsesPerForm: {
        // All stored responses over all live forms (not limited to the range).
        value: totalForms > 0 ? responsesTotal / totalForms : null,
        responses: responsesTotal,
        forms: totalForms,
      },
      topWorkspaces: top.workspaces,
      topForms: top.forms,
      uploads: {
        perDay: uploadCount,
        bytesPerDay: uploadBytes,
        // Counts every file ever uploaded: deleted files are gone from the collection, so this is growth in uploads, not net storage.
        cumulativeBytes,
        note: "Uploads created; deleted files are not subtracted.",
      },
      exportsPerDay: { csv: exportsBy("csv"), pdf: exportsBy("pdf"), failed: exportsFailed },
      templates: { top: templateTop, formsCreatedFromTemplatesInRange: templateFormsInRange, formsCreatedFromTemplatesTotal: templateFormsTotal },
      completionRate: completion,
    };
  });
}

/** Sums grouped rows ({ _id: { day }, n }) per day. */
function aggregateRows(rows: any[]): { _id: string; n: number }[] {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r._id.day, (byDay.get(r._id.day) ?? 0) + r.n);
  return [...byDay].map(([_id, n]) => ({ _id, n }));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Mail: outcomes per day, from MailLog by createdAt. MailLog keeps only 30 days (a TTL index purges older rows), so a range reaching
// further back shows zeros for the purged days: they are not "no mail", they are gone. One $group by day and outcome.
// ---------------------------------------------------------------------------------------------------------------------------------
export function getMailMetrics(input: MetricsInput) {
  return run("mail", input, async (range) => {
    const rows = await MailLog.aggregate([
      { $match: between("createdAt", range.from, range.to) },
      { $group: { _id: { day: dayOf("createdAt"), outcome: "$outcome" }, n: { $sum: 1 } } },
    ]);
    const series = (outcome: string) => denseSeries(range.dayKeys, aggregateRows(rows.filter((r: any) => r._id.outcome === outcome)));
    const sent = series("sent");
    const failed = series("failed");
    const rateLimited = series("rate_limited");
    const queued = series("queued");
    const totals = { sent: sum(sent), failed: sum(failed), rateLimited: sum(rateLimited), queued: sum(queued) };
    return {
      days: range.dayKeys,
      sent,
      failed,
      rateLimited,
      queued,
      totals,
      deliveryRate: totals.sent + totals.failed > 0 ? totals.sent / (totals.sent + totals.failed) : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Needs attention: counts only, each linking to the page that explains it. Not range based.
// ---------------------------------------------------------------------------------------------------------------------------------
export async function getAttentionMetrics(input: Pick<MetricsInput, "refresh">) {
  const c = await cachedFor(
    "attention",
    CACHE_MS,
    async () => {
      const now = Date.now();
      const day = new Date(now - DAY_MS);
      const week = new Date(now - 7 * DAY_MS);
      const [errorLogs24h, failedMail24h, failedExports, accountsOverQuota, rateLimitHits7d, honeypotDrops7d] = await Promise.all([
        SystemLog.countDocuments({ level: "error", createdAt: { $gte: day } }),
        MailLog.countDocuments({ outcome: "failed", createdAt: { $gte: day } }),
        ReportModel.countDocuments({ status: "failed" }),
        User.countDocuments({ ...ADMINS, $expr: { $gt: ["$storageUsedBytes", "$storageQuotaBytes"] } }),
        SystemLog.countDocuments({ "meta.type": "rate_limit", createdAt: { $gte: week } }),
        SystemLog.countDocuments({ "meta.type": "honeypot_drop", createdAt: { $gte: week } }),
      ]);
      return {
        errorLogs24h: { value: errorLogs24h, href: "/logs?level=error" },
        failedMail24h: { value: failedMail24h, href: "/mail-logs?outcome=failed" },
        failedExports: { value: failedExports, href: "/exports?status=failed" },
        accountsOverQuota: { value: accountsOverQuota, href: "/storage?state=over_quota" },
        abuseHits7d: { value: rateLimitHits7d + honeypotDrops7d, rateLimited: rateLimitHits7d, honeypotDrops: honeypotDrops7d, href: "/overview" },
        // Backend dependency vulnerabilities and release state come from GET /health and the Releases overview.
      };
    },
    !!input.refresh
  );
  return { data: c.value, meta: { timezone: "UTC" as const, computedAt: c.computedAt, cached: c.cached } };
}
