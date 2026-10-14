import mongoose, { Schema } from "mongoose";
import { mailService } from "./mail.service";
// Registered here so the hooks can resolve them by name from any entry point (scripts, tests).
import "../models/User";
import "../models/Workspace";
import "../models/Notification";

// Per-user storage quota + workspace-count limit.
//
// `User.storageUsedBytes` is a RUNNING counter, never recomputed on read. Everything a user owns counts:
// forms, responses (test and trashed ones too) and Upload rows. Trash does not touch it; only a permanent
// purge does. Storage inside a workspace is charged to the workspace OWNER, never to the member who caused
// it. All the increment/decrement logic lives in this file so a future per-workspace cap hooks in once.
//
// This module imports no model: it resolves them by name, so Form/Response/Upload can import it to attach
// their hooks without an import cycle.

export const MB = 1024 * 1024;
export const DEFAULT_STORAGE_QUOTA_BYTES = 500 * MB;
export const DEFAULT_WORKSPACE_LIMIT = 10;
// Hard stop for public text submissions = base quota x 1.2 (500MB -> 600MB). Everything else stops at the base.
export const HARD_CEILING_FACTOR = 1.2;
export const WARN_AT = 0.8;

export const hardCeilingOf = (quota: number): number => Math.round(quota * HARD_CEILING_FACTOR);

const model = (name: string): mongoose.Model<any> => mongoose.model(name);

export const bsonSize = (doc: unknown): number => {
  const plain = doc && typeof (doc as any).toObject === "function" ? (doc as any).toObject({ minimize: false }) : doc;
  return mongoose.mongo.BSON.calculateObjectSize(plain as any);
};

// ---------------------------------------------------------------------------------------------------
// Who is charged
// ---------------------------------------------------------------------------------------------------

/** The workspace owner, or the form's creator for a personal form. */
export const ownerOfForm = async (form: { workspaceId?: unknown; createdBy?: unknown } | null | undefined): Promise<mongoose.Types.ObjectId | null> => {
  if (!form) return null;
  if (form.workspaceId) {
    const ws = await model("Workspace").findById(form.workspaceId).select("owner").lean();
    if (ws?.owner) return ws.owner as mongoose.Types.ObjectId;
  }
  return (form.createdBy as mongoose.Types.ObjectId) ?? null;
};

export const ownerOfFormId = async (formId: unknown): Promise<mongoose.Types.ObjectId | null> => {
  if (!formId) return null;
  const form = await model("Form").findById(formId).setOptions({ includeDeleted: true }).select("workspaceId createdBy").lean();
  return ownerOfForm(form);
};

// ---------------------------------------------------------------------------------------------------
// The counter
// ---------------------------------------------------------------------------------------------------

export const adjustStorage = async (ownerId: unknown, delta: number): Promise<void> => {
  if (!ownerId || !delta) return;
  const User = model("User");
  const after = await User.findOneAndUpdate(
    { _id: ownerId },
    { $inc: { storageUsedBytes: delta } },
    { returnDocument: "after" }
  ).select("storageUsedBytes storageQuotaBytes").lean();
  if (after && delta > 0) await notifyIfThresholdCrossed(ownerId, after.storageUsedBytes - delta, after.storageUsedBytes, after.storageQuotaBytes);
};

const notifyIfThresholdCrossed = async (userId: unknown, before: number, after: number, quota: number): Promise<void> => {
  const crossed = (limit: number) => before < limit && after >= limit;
  let title: string | null = null;
  let message = "";
  let level: "almost_full" | "full" = "almost_full";
  if (crossed(quota)) {
    level = "full";
    title = "Storage full";
    message = "You have used all of your storage. You can't create forms or upload files until you free up space. Emptying Trash is the quickest way.";
  } else if (crossed(quota * WARN_AT)) {
    title = "Storage almost full";
    message = "You have used 80% of your storage. Emptying Trash frees up space.";
  }
  if (!title) return;
  try {
    await model("Notification").create({ userId, type: "storage_warning", title, message });
    const user = await model("User").findById(userId).select("email fullName").lean();
    if (user?.email) {
      await mailService.sendMail({ to: user.email, template: "storage_warning", payload: { level, usedBytes: after, quotaBytes: quota } });
    }
  } catch (err) {
    console.warn("Storage warning delivery failed:", err);
  }
};

export type QuotaDecision =
  | { ok: true }
  | { ok: false; reason: "QUOTA" | "CEILING"; used: number; quota: number };

/**
 * The one threshold check. `allowGraceOverage` is for the public text-answer path only: it may keep
 * accepting until the hard ceiling. Everything else is blocked as soon as the base quota would be passed.
 */
export const checkStorageQuota = async (
  userId: unknown,
  { bytesToAdd = 0, allowGraceOverage = false }: { bytesToAdd?: number; allowGraceOverage?: boolean } = {}
): Promise<QuotaDecision> => {
  if (!userId) return { ok: true };
  const u = await model("User").findById(userId).select("storageUsedBytes storageQuotaBytes").lean();
  if (!u) return { ok: true };
  const used = u.storageUsedBytes ?? 0;
  const quota = u.storageQuotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES;
  const limit = allowGraceOverage ? hardCeilingOf(quota) : quota;
  if (used + bytesToAdd > limit) return { ok: false, reason: allowGraceOverage ? "CEILING" : "QUOTA", used, quota };
  return { ok: true };
};

export const assertStorageQuota = async (userId: unknown, opts: { bytesToAdd?: number } = {}): Promise<void> => {
  const d = await checkStorageQuota(userId, opts);
  if (!d.ok) {
    throw Object.assign(new Error("Storage limit reached. Free up space or contact support."), {
      statusCode: 403,
      code: "STORAGE_QUOTA_EXCEEDED",
    });
  }
};

/** Public-form gate: past the base quota file attachments stop; past the ceiling the whole form is unavailable. */
export const publicFormStorageState = async (form: { workspaceId?: unknown; createdBy?: unknown }): Promise<"ok" | "no_files" | "unavailable"> => {
  const owner = await ownerOfForm(form);
  if (!owner) return "ok";
  if (!(await checkStorageQuota(owner, { allowGraceOverage: true })).ok) return "unavailable";
  if (!(await checkStorageQuota(owner)).ok) return "no_files";
  return "ok";
};

export const assertWorkspaceLimit = async (userId: unknown): Promise<void> => {
  const u = await model("User").findById(userId).select("workspaceLimit").lean();
  const limit = u?.workspaceLimit ?? DEFAULT_WORKSPACE_LIMIT;
  const owned = await model("Workspace").countDocuments({ owner: userId });
  if (owned >= limit) {
    throw Object.assign(new Error(`You can own at most ${limit} workspaces.`), { statusCode: 403, code: "WORKSPACE_LIMIT_REACHED" });
  }
};

// ---------------------------------------------------------------------------------------------------
// Hooks: every create / edit / permanent delete of an Upload, Form or Response moves the counter.
// ---------------------------------------------------------------------------------------------------

type Kind = "upload" | "form" | "response";

const chargedTo = async (kind: Kind, doc: any): Promise<unknown> => {
  if (kind === "upload") return doc.chargedTo ?? doc.owner;
  if (kind === "form") return ownerOfForm(doc);
  return ownerOfFormId(doc.formId);
};

// Every size is the STORED document's size ($bsonSize, the same measure reconciliation uses), never the
// in-memory document's: the two differ by defaults and virtuals, and mixing them would drift on every edit.
const rowsOf = async (m: mongoose.Model<any>, ids: unknown[]): Promise<any[]> => {
  if (!ids.length) return [];
  const agg = m.aggregate([
    { $match: { _id: { $in: ids } } },
    { $project: { n: { $bsonSize: "$$ROOT" }, size: 1, owner: 1, chargedTo: 1, workspaceId: 1, createdBy: 1, formId: 1 } },
  ]);
  agg.option({ includeTest: true });
  return agg;
};
const bytesOf = (kind: Kind, row: any): number => (kind === "upload" ? Number(row.size) || 0 : row.n);
const storedBytes = async (m: mongoose.Model<any>, id: unknown, kind: Kind): Promise<number | undefined> => {
  const row = (await rowsOf(m, [id]))[0];
  return row ? bytesOf(kind, row) : undefined;
};

// Measure what a delete is about to remove and subtract it from each owner, in one pass.
const releaseMatching = async (query: any, kind: Kind): Promise<void> => {
  const m: mongoose.Model<any> = query.model;
  const found = await m.find(query.getFilter()).setOptions({ includeDeleted: true, includeTest: true }).select("_id").lean();
  const perOwner = new Map<string, number>();
  const ownerCache = new Map<string, unknown>();
  for (let i = 0; i < found.length; i += 5000) {
    for (const row of await rowsOf(m, found.slice(i, i + 5000).map((d: any) => d._id))) {
      const key = kind === "response" ? String(row.formId) : String(row._id);
      let owner = ownerCache.get(key);
      if (owner === undefined) {
        owner = await chargedTo(kind, row);
        ownerCache.set(key, owner);
      }
      if (owner) perOwner.set(String(owner), (perOwner.get(String(owner)) ?? 0) + bytesOf(kind, row));
    }
  }
  for (const [owner, bytes] of perOwner) await adjustStorage(owner, -bytes);
};

export const attachStorageHooks = (schema: Schema, kind: Kind): void => {
  // New documents and edits made through doc.save().
  schema.pre("save", async function (this: any) {
    this.$locals.storageWasNew = this.isNew;
    if (this.isNew || kind === "upload") return;
    if (kind === "response" && !this.isModified("answers")) return;
    this.$locals.storageOldBytes = await storedBytes(this.constructor as mongoose.Model<any>, this._id, kind);
  });
  schema.post("save", async function (this: any) {
    const m = this.constructor as mongoose.Model<any>;
    const now = await storedBytes(m, this._id, kind);
    if (now === undefined) return;
    const delta = this.$locals.storageWasNew ? now : this.$locals.storageOldBytes === undefined ? 0 : now - this.$locals.storageOldBytes;
    this.$locals.storageOldBytes = undefined;
    await adjustStorage(await chargedTo(kind, this), delta);
  });

  // insertMany skips save hooks.
  (schema as any).post("insertMany", async function (this: mongoose.Model<any>, docs: any[]) {
    for (const d of docs) {
      const now = await storedBytes(this, d._id, kind);
      if (now !== undefined) await adjustStorage(await chargedTo(kind, d), now);
    }
  });

  // Permanent deletes.
  schema.pre(["deleteOne", "deleteMany", "findOneAndDelete"] as any, { query: true, document: false } as any, async function (this: any) {
    await releaseMatching(this, kind);
  });

  // Form autosave goes through findOneAndUpdate(returnDocument: "after"): the delta is after - before.
  if (kind === "form") {
    schema.pre("findOneAndUpdate", async function (this: any) {
      // Moving to / out of Trash must not touch the counter. Those few bytes of metadata are left to reconciliation.
      const update = this.getUpdate() ?? {};
      const keys = Object.keys(update.$set ?? update).filter((k) => !k.startsWith("$"));
      if (keys.length && keys.every((k) => k === "deletedAt" || k === "deletedBy")) {
        this._storageOldBytes = undefined;
        return;
      }
      const old = await this.model.findOne(this.getFilter()).setOptions({ includeDeleted: true }).select("_id").lean();
      this._storageOldBytes = old ? await storedBytes(this.model, old._id, kind) : undefined;
    });
    schema.post("findOneAndUpdate", async function (this: any, doc: any) {
      if (!doc || this._storageOldBytes === undefined) return;
      const now = await storedBytes(this.model, doc._id, kind);
      if (now !== undefined) await adjustStorage(await chargedTo(kind, doc), now - this._storageOldBytes);
    });
  }
};

/** For writes that bypass the hooks (updateOne $set answers): charge the owner the stored size change. */
export const trackResponseWrite = async (responseId: unknown, formId: unknown, write: () => Promise<unknown>): Promise<void> => {
  const m = model("Response");
  const before = await storedBytes(m, responseId, "response");
  await write();
  const after = await storedBytes(m, responseId, "response");
  if (before !== undefined && after !== undefined) await adjustStorage(await ownerOfFormId(formId), after - before);
};

// ---------------------------------------------------------------------------------------------------
// Reconciliation: recompute true usage from scratch (trashed items included) and compare.
// ---------------------------------------------------------------------------------------------------

const sumBson = async (m: mongoose.Model<any>, match: any, options: Record<string, boolean> = {}): Promise<number> => {
  const agg = m.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: { $bsonSize: "$$ROOT" } } } }]);
  if (options.includeTest) agg.option({ includeTest: true });
  return (await agg)[0]?.total ?? 0;
};

export const computeTrueUsage = async (userId: mongoose.Types.ObjectId | string): Promise<number> => {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const Form = model("Form");
  const owned = (await model("Workspace").find({ owner: uid }).select("_id").lean()).map((w: any) => w._id);
  const formMatch = { $or: [{ workspaceId: { $in: owned } }, { createdBy: uid, workspaceId: null }] };
  const forms = await Form.find(formMatch).setOptions({ includeDeleted: true }).select("_id").lean();
  const formIds = forms.map((f: any) => f._id);

  const formBytes = await sumBson(Form, { _id: { $in: formIds } });
  const responseBytes = await sumBson(model("Response"), { formId: { $in: formIds } }, { includeTest: true });
  const uploads = await model("Upload").aggregate([
    { $match: { $or: [{ chargedTo: uid }, { chargedTo: null, owner: uid }] } },
    { $group: { _id: null, total: { $sum: "$size" } } },
  ]);
  return formBytes + responseBytes + (uploads[0]?.total ?? 0);
};

export interface ReconcileResult {
  userId: string;
  stored: number;
  actual: number;
  drift: number;
  fixed: boolean;
}

/** Always corrects a mismatch; `dryRun` only reports it. */
export const reconcileUser = async (userId: mongoose.Types.ObjectId | string, { dryRun = false } = {}): Promise<ReconcileResult> => {
  const user = await model("User").findById(userId).select("storageUsedBytes").lean();
  const stored = user?.storageUsedBytes ?? 0;
  const actual = await computeTrueUsage(userId);
  const drift = stored - actual;
  if (drift !== 0) {
    console.warn(`[storage] drift for user ${userId}: stored ${stored}, actual ${actual} (${drift > 0 ? "+" : ""}${drift})`);
    if (!dryRun) await model("User").updateOne({ _id: userId }, { $set: { storageUsedBytes: actual } });
  }
  return { userId: String(userId), stored, actual, drift, fixed: drift !== 0 && !dryRun };
};

/**
 * Bytes sitting in Trash (they still count toward the total) - lets the sidebar split "active" from "in Trash".
 * Computed on demand from the trashed items only; the running counter stays the single source for the total.
 */
export const trashBytesOf = async (userId: mongoose.Types.ObjectId | string): Promise<number> => {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const Form = model("Form");
  const Response = model("Response");
  const Upload = model("Upload");
  const owned = (await model("Workspace").find({ owner: uid }).select("_id").lean()).map((w: any) => w._id);
  const mine = { $or: [{ workspaceId: { $in: owned } }, { createdBy: uid, workspaceId: null }] };

  const trashedForms = await Form.find({ ...mine, deletedAt: { $ne: null } }).setOptions({ includeDeleted: true }).select("_id").lean();
  const trashedFormIds = trashedForms.map((f: any) => f._id);
  const liveFormIds = (await Form.find(mine).select("_id").lean()).map((f: any) => f._id);

  const pathMatchers: RegExp[] = trashedFormIds.slice(0, 200).map((id: any) => new RegExp(`(^|[\\/])${id}[\\/]`));
  const trashedResponses = liveFormIds.length
    ? await Response.find({ formId: { $in: liveFormIds }, deletedAt: { $ne: null } }).setOptions({ includeTest: true }).select("_id").limit(200).lean()
    : [];
  trashedResponses.forEach((r: any) => pathMatchers.push(new RegExp(`(^|[\\/])responses[\\/]${r._id}[\\/]`)));

  const [formBytes, inFormResponses, ownResponses, uploads] = await Promise.all([
    sumBson(Form, { _id: { $in: trashedFormIds } }),
    sumBson(Response, { formId: { $in: trashedFormIds } }, { includeTest: true }),
    sumBson(Response, { _id: { $in: trashedResponses.map((r: any) => r._id) } }, { includeTest: true }),
    pathMatchers.length
      ? Upload.aggregate([{ $match: { $or: pathMatchers.map((rx) => ({ path: { $regex: rx } })) } }, { $group: { _id: null, total: { $sum: "$size" } } }])
      : Promise.resolve([]),
  ]);
  return formBytes + inFormResponses + ownResponses + ((uploads as any[])[0]?.total ?? 0);
};
