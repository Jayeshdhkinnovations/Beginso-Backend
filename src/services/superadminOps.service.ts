import mongoose from "mongoose";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Template from "../models/Template";
import ReportModel from "../models/Report";
import SessionModel from "../models/Session";
import { AuditLog, IAuditLog } from "../models/AuditLog";
import { escapeRegex } from "../utils/safeInput";
import { buildInfo } from "../utils/buildInfo";
import { auditInfo, parseAuditSummary, AuditSummary } from "../utils/auditInfo";
import { deleteWorkspaceData } from "./cleanup.service";
import { kickReportQueue } from "./reportQueue";
import { DEFAULT_STORAGE_QUOTA_BYTES, DEFAULT_WORKSPACE_LIMIT, hardCeilingOf } from "./storage.service";

// Operator-console surfaces added after the first five screens: storage, workspaces, built-in templates,
// per-user sessions, platform health and export jobs. Every mutation writes an AuditLog row.

export type Actor = { id: string; email: string; fullName: string };

const httpError = (statusCode: number, message: string): Error => Object.assign(new Error(message), { statusCode });

const audit = (actor: Actor, action: IAuditLog["action"], targetType: IAuditLog["targetType"], targetId: string, before?: Record<string, any>, after?: Record<string, any>) =>
  AuditLog.create({
    actorId: actor.id,
    actorEmail: actor.email,
    actorName: actor.fullName,
    action,
    targetId,
    targetType,
    before,
    after,
  });

const page = (query: { page?: number; limit?: number }) => {
  const p = Math.max(1, Math.floor(query.page || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit || 50)));
  return { page: p, limit, skip: (p - 1) * limit };
};

const pagination = (total: number, p: number, limit: number) => ({ total, page: p, limit, pages: Math.ceil(total / limit) });

const validId = (id: string): void => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw httpError(404, "Not found");
};

// ---------------------------------------------------------------------------------------------------
// Storage & quota
// ---------------------------------------------------------------------------------------------------

export type StorageState = "under" | "over_quota" | "over_ceiling";

export const getStorage = async (query: { page?: number; limit?: number; search?: string; state?: StorageState }) => {
  const { page: p, limit, skip } = page(query);
  const match: any = { role: "admin" };
  if (query.search) {
    const rx = { $regex: escapeRegex(query.search), $options: "i" };
    match.$or = [{ fullName: rx }, { email: rx }];
  }

  const withState = [
    { $match: match },
    {
      $addFields: {
        quota: { $ifNull: ["$storageQuotaBytes", DEFAULT_STORAGE_QUOTA_BYTES] },
        used: { $ifNull: ["$storageUsedBytes", 0] },
      },
    },
    { $addFields: { overBy: { $subtract: ["$used", "$quota"] } } },
    {
      $addFields: {
        state: {
          $switch: {
            branches: [
              { case: { $gt: ["$used", { $round: [{ $multiply: ["$quota", 1.2] }, 0] }] }, then: "over_ceiling" },
              { case: { $gt: ["$used", "$quota"] }, then: "over_quota" },
            ],
            default: "under",
          },
        },
      },
    },
    ...(query.state ? [{ $match: { state: query.state } }] : []),
  ];

  const [rows, count, totals] = await Promise.all([
    User.aggregate([
      ...withState,
      { $sort: { overBy: -1, _id: 1 } },
      { $skip: skip },
      { $limit: limit },
      { $project: { fullName: 1, email: 1, used: 1, quota: 1, overBy: 1, state: 1, workspaceLimit: 1 } },
    ]),
    User.aggregate([...withState, { $count: "n" }]),
    User.aggregate([
      { $match: { role: "admin" } },
      {
        $group: {
          _id: null,
          used: { $sum: { $ifNull: ["$storageUsedBytes", 0] } },
          overQuota: { $sum: { $cond: [{ $gt: [{ $ifNull: ["$storageUsedBytes", 0] }, { $ifNull: ["$storageQuotaBytes", DEFAULT_STORAGE_QUOTA_BYTES] }] }, 1, 0] } },
          overCeiling: {
            $sum: {
              $cond: [
                { $gt: [{ $ifNull: ["$storageUsedBytes", 0] }, { $round: [{ $multiply: [{ $ifNull: ["$storageQuotaBytes", DEFAULT_STORAGE_QUOTA_BYTES] }, 1.2] }, 0] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);

  const ids = rows.map((r: any) => r._id);
  const wsCounts = await Workspace.aggregate([{ $match: { owner: { $in: ids } } }, { $group: { _id: "$owner", n: { $sum: 1 } } }]);
  const wsOf = new Map(wsCounts.map((w: any) => [String(w._id), w.n as number]));

  return {
    totals: { totalStorageUsed: totals[0]?.used ?? 0, overQuota: totals[0]?.overQuota ?? 0, overCeiling: totals[0]?.overCeiling ?? 0 },
    data: rows.map((r: any) => ({
      id: String(r._id),
      name: r.fullName,
      email: r.email,
      storageUsed: r.used,
      storageQuota: r.quota,
      hardCeiling: hardCeilingOf(r.quota),
      workspaceCount: wsOf.get(String(r._id)) ?? 0,
      workspaceLimit: r.workspaceLimit ?? DEFAULT_WORKSPACE_LIMIT,
      state: r.state as StorageState,
    })),
    pagination: pagination(count[0]?.n ?? 0, p, limit),
  };
};

// ---------------------------------------------------------------------------------------------------
// Workspaces (read + delete)
// ---------------------------------------------------------------------------------------------------

export const listWorkspaces = async (query: { page?: number; limit?: number; search?: string }) => {
  const { page: p, limit, skip } = page(query);
  const filter: any = query.search ? { name: { $regex: escapeRegex(query.search), $options: "i" } } : {};
  const [total, workspaces] = await Promise.all([
    Workspace.countDocuments(filter),
    Workspace.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("owner", "fullName email storageUsedBytes").lean(),
  ]);
  const ids = workspaces.map((w: any) => w._id);
  const [members, forms] = await Promise.all([
    Membership.aggregate([{ $match: { workspaceId: { $in: ids } } }, { $group: { _id: "$workspaceId", n: { $sum: 1 } } }]),
    Form.aggregate([{ $match: { workspaceId: { $in: ids } } }, { $group: { _id: "$workspaceId", n: { $sum: 1 } } }]),
  ]);
  const memberOf = new Map(members.map((m: any) => [String(m._id), m.n as number]));
  const formsOf = new Map(forms.map((m: any) => [String(m._id), m.n as number]));

  return {
    data: workspaces.map((w: any) => ({
      id: String(w._id),
      name: w.name,
      slug: w.slug,
      owner: w.owner ? { id: String(w.owner._id), name: w.owner.fullName, email: w.owner.email } : null,
      memberCount: memberOf.get(String(w._id)) ?? 0,
      formCount: formsOf.get(String(w._id)) ?? 0,
      createdAt: w.createdAt,
    })),
    pagination: pagination(total, p, limit),
  };
};

export const getWorkspace = async (id: string) => {
  validId(id);
  const w: any = await Workspace.findById(id).populate("owner", "fullName email storageUsedBytes storageQuotaBytes").lean();
  if (!w) throw httpError(404, "Workspace not found");
  const memberships = await Membership.find({ workspaceId: w._id }).populate("userId", "fullName email").lean();
  const formIds = (await Form.find({ workspaceId: w._id }).setOptions({ includeDeleted: true }).select("_id").lean()).map((f) => f._id);
  const [formCount, responseCount] = await Promise.all([
    Form.countDocuments({ workspaceId: w._id }),
    formIds.length ? ResponseModel.countDocuments({ formId: { $in: formIds } }).setOptions({ includeTest: true }) : 0,
  ]);
  return {
    workspace: {
      id: String(w._id),
      name: w.name,
      slug: w.slug,
      status: w.status,
      createdAt: w.createdAt,
      owner: w.owner
        ? { id: String(w.owner._id), name: w.owner.fullName, email: w.owner.email, storageUsed: w.owner.storageUsedBytes ?? 0, storageQuota: w.owner.storageQuotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES }
        : null,
    },
    members: memberships.map((m: any) => ({
      userId: m.userId ? String(m.userId._id) : null,
      name: m.userId?.fullName ?? "Deleted user",
      email: m.userId?.email ?? "",
      role: m.role,
    })),
    usage: { formCount, responseCount },
  };
};

export const deleteWorkspace = async (actor: Actor, id: string, confirmName: unknown) => {
  validId(id);
  const w = await Workspace.findById(id);
  if (!w) throw httpError(404, "Workspace not found");
  if (confirmName !== w.name) throw httpError(422, "Confirmation name does not match the workspace name exactly.");
  const before = { name: w.name, owner: String(w.owner) };
  await deleteWorkspaceData(w._id);
  await audit(actor, "workspace.delete", "workspace", id, before);
  return { deleted: true };
};

// ---------------------------------------------------------------------------------------------------
// Built-in templates (workspaceId null). Workspace-published templates are never visible or touchable here.
// ---------------------------------------------------------------------------------------------------

const BUILT_IN = { workspaceId: null };

const templateRow = (t: any, usage: number) => ({
  id: String(t._id),
  name: t.name,
  description: t.description,
  category: t.category,
  theme: t.theme,
  isActive: t.isActive,
  fieldCount: (t.fields ?? []).length,
  usageCount: usage,
  updatedAt: t.updatedAt,
});

export const listTemplates = async (query: { page?: number; limit?: number; search?: string }) => {
  const { page: p, limit, skip } = page(query);
  const filter: any = { ...BUILT_IN, ...(query.search ? { name: { $regex: escapeRegex(query.search), $options: "i" } } : {}) };
  const [total, templates] = await Promise.all([
    Template.countDocuments(filter),
    Template.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  const usage = await Form.aggregate([
    { $match: { templateId: { $in: templates.map((t: any) => t._id) } } },
    { $group: { _id: "$templateId", n: { $sum: 1 } } },
  ]);
  const usageOf = new Map(usage.map((u: any) => [String(u._id), u.n as number]));
  return { data: templates.map((t: any) => templateRow(t, usageOf.get(String(t._id)) ?? 0)), pagination: pagination(total, p, limit) };
};

const TEMPLATE_KEYS = ["name", "description", "category", "theme", "isActive", "fields", "pages", "settings"] as const;
const pickTemplate = (body: any): Record<string, unknown> =>
  Object.fromEntries(TEMPLATE_KEYS.filter((k) => body && body[k] !== undefined).map((k) => [k, body[k]]));

export const createTemplate = async (actor: Actor, body: any) => {
  // Forced to built-in: this console can only ever create operator-managed templates.
  const t = await Template.create({ theme: "classic-light", ...pickTemplate(body), workspaceId: null, createdBy: null });
  await audit(actor, "template.create", "template", String(t._id), undefined, { name: t.name });
  return { template: templateRow(t, 0) };
};

export const updateTemplate = async (actor: Actor, id: string, body: any) => {
  validId(id);
  const t = await Template.findOne({ _id: id, ...BUILT_IN });
  if (!t) throw httpError(404, "Template not found");
  const before = { name: t.name, category: t.category, isActive: t.isActive };
  t.set(pickTemplate(body));
  await t.save();
  await audit(actor, "template.edit", "template", id, before, { name: t.name, category: t.category, isActive: t.isActive });
  return { template: templateRow(t, await Form.countDocuments({ templateId: t._id })) };
};

export const deleteTemplate = async (actor: Actor, id: string, confirmName: unknown) => {
  validId(id);
  const t = await Template.findOne({ _id: id, ...BUILT_IN });
  if (!t) throw httpError(404, "Template not found");
  if (confirmName !== t.name) throw httpError(422, "Confirmation name does not match the template name exactly.");
  await Template.deleteOne({ _id: t._id, ...BUILT_IN });
  await audit(actor, "template.delete", "template", id, { name: t.name });
  return { deleted: true };
};

// ---------------------------------------------------------------------------------------------------
// Sessions of one user (the self-service routes are scoped to the caller)
// ---------------------------------------------------------------------------------------------------

export const listUserSessions = async (userId: string) => {
  validId(userId);
  const sessions = await SessionModel.find({ userId, revokedAt: null }).sort({ lastActiveAt: -1 }).limit(100).lean();
  return {
    sessions: sessions.map((s: any) => ({
      id: String(s._id),
      deviceLabel: s.deviceLabel,
      approxLocation: s.approxLocation && Object.keys(s.approxLocation).length ? s.approxLocation : null,
      lastActiveAt: s.lastActiveAt,
      createdAt: s.createdAt,
    })),
  };
};

export const revokeUserSession = async (actor: Actor, userId: string, sessionId: string) => {
  validId(userId);
  validId(sessionId);
  // Matched on BOTH ids so a session id from another account can never be revoked through this user's URL.
  const res = await SessionModel.updateOne({ _id: sessionId, userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (!res.matchedCount) throw httpError(404, "Session not found");
  await audit(actor, "session.revoke", "session", sessionId, { userId });
  return { revoked: 1 };
};

export const revokeAllUserSessions = async (actor: Actor, userId: string) => {
  validId(userId);
  const res = await SessionModel.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await audit(actor, "session.revoke", "session", "all", { userId, count: res.modifiedCount });
  return { revoked: res.modifiedCount };
};

/** Workspaces a user owns or belongs to, for the user detail drawer. */
export const workspacesOfUser = async (userId: mongoose.Types.ObjectId | string) => {
  const memberships = await Membership.find({ userId }).populate("workspaceId", "name").lean();
  const ids = memberships.map((m: any) => m.workspaceId?._id).filter(Boolean);
  const counts = await Membership.aggregate([{ $match: { workspaceId: { $in: ids } } }, { $group: { _id: "$workspaceId", n: { $sum: 1 } } }]);
  const countOf = new Map(counts.map((c: any) => [String(c._id), c.n as number]));
  return memberships
    .filter((m: any) => m.workspaceId)
    .map((m: any) => ({ id: String(m.workspaceId._id), name: m.workspaceId.name, role: m.role, memberCount: countOf.get(String(m.workspaceId._id)) ?? 0 }));
};

// ---------------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------------

export interface FrontendBuild {
  commit: string | null;
  commitMessage: string | null;
  builtAt: string | null;
}

// The product frontend publishes /build-info.json at build time (scripts/write-build-info.mjs). Fetched with a short
// timeout and cached for 5 minutes per process, so the health page never waits on, or hammers, the frontend host.
let frontendCache: { at: number; value: { build: FrontendBuild; audit: AuditSummary | null } | null } | null = null;
const FRONTEND_CACHE_MS = 5 * 60 * 1000;

export const fetchFrontendBuild = async (now = Date.now()): Promise<{ build: FrontendBuild; audit: AuditSummary | null } | null> => {
  if (frontendCache && now - frontendCache.at < FRONTEND_CACHE_MS) return frontendCache.value;
  let value: { build: FrontendBuild; audit: AuditSummary | null } | null = null;
  try {
    const base = (process.env.APP_URL || "https://beginso.com").replace(/\/+$/, "");
    const res = await fetch(`${base}/build-info.json`, { signal: AbortSignal.timeout(3000), headers: { accept: "application/json" } });
    if (res.ok) {
      const raw: any = await res.json();
      const str = (v: unknown) => (typeof v === "string" ? v : null);
      value = { build: { commit: str(raw.commit), commitMessage: str(raw.commitMessage), builtAt: str(raw.builtAt) }, audit: parseAuditSummary(raw.audit) };
    }
  } catch {
    value = null; // frontend unreachable: shown as "not exposed", never an error on the health page
  }
  frontendCache = { at: now, value };
  return value;
};

export const resetFrontendBuildCache = (): void => {
  frontendCache = null;
};

export const getHealth = async () => {
  const [counts, frontend] = await Promise.all([
    ReportModel.aggregate([{ $match: { status: { $in: ["queued", "processing", "failed"] } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    fetchFrontendBuild(),
  ]);
  const n = (s: string) => counts.find((c: any) => c._id === s)?.n ?? 0;
  return {
    backend: { commit: buildInfo.commit, commitMessage: buildInfo.commitMessage, deployedAt: buildInfo.deployedAt },
    frontend: frontend?.build ?? null,
    // null = not recorded: dist/audit.json (backend) comes from the deploy workflow, build-info.json (frontend) from its build.
    dependencyVulnerabilities: { backend: auditInfo, frontend: frontend?.audit ?? null },
    reportQueue: { queued: n("queued"), processing: n("processing"), failed: n("failed") },
    smtp: { tlsVerification: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false" },
  };
};

// ---------------------------------------------------------------------------------------------------
// Export jobs
// ---------------------------------------------------------------------------------------------------

export const listExports = async (query: { page?: number; limit?: number; status?: string }) => {
  const { page: p, limit, skip } = page(query);
  const filter: any = query.status ? { status: query.status } : {};
  const [total, reports] = await Promise.all([
    ReportModel.countDocuments(filter),
    ReportModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("requestedBy", "fullName email").populate("workspaceId", "name").lean(),
  ]);
  return {
    data: reports.map((r: any) => ({
      id: String(r._id),
      format: r.format,
      status: r.status,
      errorMessage: r.status === "failed" ? r.errorMessage ?? null : null,
      requestedBy: r.requestedBy ? { name: r.requestedBy.fullName, email: r.requestedBy.email } : null,
      workspaceName: r.workspaceId?.name ?? "Personal",
      rowCount: r.rowCount ?? null,
      createdAt: r.createdAt,
    })),
    pagination: pagination(total, p, limit),
  };
};

export const retryExport = async (actor: Actor, id: string) => {
  validId(id);
  const res = await ReportModel.updateOne({ _id: id, status: "failed" }, { $set: { status: "queued" }, $unset: { errorMessage: 1 } });
  if (!res.matchedCount) throw httpError(404, "No failed export with that id");
  await audit(actor, "report.retry", "report", id);
  kickReportQueue();
  return { requeued: true };
};
