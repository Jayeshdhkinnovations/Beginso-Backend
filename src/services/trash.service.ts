import mongoose from "mongoose";
import Form, { IForm } from "../models/Form";
import ResponseModel, { IResponse } from "../models/Response";
import Upload from "../models/Upload";
import User from "../models/User";
import Note from "../models/Note";
import ScoreEntry from "../models/ScoreEntry";
import ResponseReadState from "../models/ResponseReadState";
import RespondentLink from "../models/RespondentLink";
import { FormService } from "./form.service";
import { deleteResponseFiles } from "./cleanup.service";
import { logWorkspaceEvent } from "./event.service";
import { hasPermission } from "../middleware/permission.middleware";
import { WorkspaceRole } from "../types/workspace.types";

// Sprint 13, BE 0.8 / 0.9 (CF5.5). Trash is the mistake-recovery buffer: deleting a form or a response
// hides it, a countdown runs, and after 30 days the retention sweep removes it for good. Everything here is
// scoped to ONE context - a workspace, or the caller's personal space - and every permission rule is the
// same one the original delete used:
//   forms      restore / delete now / empty  -> Owner only (forms:delete)
//   responses  restore / delete now          -> Owner or Admin (responses:delete)
// A form's responses are NOT listed separately: they are hidden with their form (every response read is
// scoped through forms, and a trashed form is invisible to those reads) and come back with it.

export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const formService = new FormService();

export interface TrashScope {
  /** null = the caller's personal space. */
  workspaceId: string | null;
  userId: string;
  userEmail: string;
  userName: string;
  /** Workspace role; ignored (the caller is the owner) in personal space. */
  role: WorkspaceRole | null;
}

export type TrashType = "form" | "response";

const httpError = (statusCode: number, message: string, code?: string): Error => {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
};

const can = (scope: TrashScope, permission: string): boolean =>
  scope.workspaceId === null || (!!scope.role && hasPermission(scope.role, permission));

export const canTrashForms = (scope: TrashScope): boolean => can(scope, "forms:delete");
export const canTrashResponses = (scope: TrashScope): boolean => can(scope, "responses:delete");

export const purgeAtOf = (deletedAt: Date): Date => new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS);
export const daysLeftOf = (deletedAt: Date, now: Date = new Date()): number =>
  Math.max(0, Math.ceil((purgeAtOf(deletedAt).getTime() - now.getTime()) / DAY_MS));

// Forms that belong to this context. Personal = made by the caller and never moved into a workspace.
const formScopeFilter = (scope: TrashScope): Record<string, unknown> =>
  scope.workspaceId
    ? { workspaceId: scope.workspaceId }
    : { createdBy: scope.userId, $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }] };

const logEvent = async (scope: TrashScope, form: Pick<IForm, "workspaceId">, action: string, targetId: string, label: string) => {
  if (!form.workspaceId) return; // personal forms have no workspace feed
  await logWorkspaceEvent({
    workspaceId: form.workspaceId,
    actor: { id: scope.userId, email: scope.userEmail, name: scope.userName },
    action,
    targetId,
    targetType: action.startsWith("response") ? "response" : "form",
    targetLabel: label,
  });
};

// ---------------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------------

export const listTrash = async (scope: TrashScope, options: { type?: TrashType; page?: number; limit?: number }) => {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 25)));
  const now = new Date();
  const wantForms = !options.type || options.type === "form";
  const wantResponses = !options.type || options.type === "response";

  const trashedForms = wantForms
    ? await Form.find({ ...formScopeFilter(scope), deletedAt: { $ne: null } })
        .setOptions({ includeDeleted: true })
        .sort({ deletedAt: -1 })
        .lean()
    : [];

  // Responses deleted on their own: only those whose form is still live (a response inside a trashed form
  // belongs to the form's entry, not its own).
  const liveFormIds = wantResponses ? (await Form.find(formScopeFilter(scope)).select("_id title").lean()) : [];
  const liveTitle = new Map(liveFormIds.map((f: any) => [String(f._id), f.title as string]));
  const trashedResponses = wantResponses && liveFormIds.length
    ? await ResponseModel.find({ formId: { $in: liveFormIds.map((f: any) => f._id) }, deletedAt: { $ne: null } })
        .sort({ deletedAt: -1 })
        .limit(page * limit)
        .lean()
    : [];

  const userIds = new Set<string>();
  trashedForms.forEach((f: any) => f.deletedBy && userIds.add(String(f.deletedBy)));
  trashedResponses.forEach((r: any) => r.deletedBy && userIds.add(String(r.deletedBy)));
  const users = userIds.size ? await User.find({ _id: { $in: [...userIds] } }).select("fullName email").lean() : [];
  const nameOf = new Map(users.map((u: any) => [String(u._id), (u.fullName as string) || (u.email as string)]));
  const deletedBy = (id: unknown) => (id ? { id: String(id), name: nameOf.get(String(id)) ?? "Unknown" } : null);

  const responseCounts = trashedForms.length
    ? await ResponseModel.aggregate([
        { $match: { formId: { $in: trashedForms.map((f: any) => f._id) }, deletedAt: null } },
        { $group: { _id: "$formId", n: { $sum: 1 } } },
      ])
    : [];
  const countByForm = new Map(responseCounts.map((c: any) => [String(c._id), c.n as number]));

  const items = [
    ...(wantForms
      ? trashedForms.map((f: any) => ({
          id: String(f._id),
          type: "form" as const,
          name: f.title as string,
          responseCount: countByForm.get(String(f._id)) ?? 0,
          deletedAt: f.deletedAt as Date,
          deletedBy: deletedBy(f.deletedBy),
          purgeAt: purgeAtOf(f.deletedAt),
          daysLeft: daysLeftOf(f.deletedAt, now),
          canRestore: canTrashForms(scope),
          canPurge: canTrashForms(scope),
        }))
      : []),
    ...trashedResponses.map((r: any) => ({
      id: String(r._id),
      type: "response" as const,
      name: `${r.reference || String(r._id).slice(-6)} · ${liveTitle.get(String(r.formId)) ?? "Form"}`,
      formId: String(r.formId),
      formTitle: liveTitle.get(String(r.formId)) ?? "",
      deletedAt: r.deletedAt as Date,
      deletedBy: deletedBy(r.deletedBy),
      purgeAt: purgeAtOf(r.deletedAt),
      daysLeft: daysLeftOf(r.deletedAt, now),
      canRestore: canTrashResponses(scope),
      canPurge: canTrashResponses(scope),
    })),
  ].sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());

  // Trash counts toward storage (stated on the screen): sum the files under every trashed form.
  let storageBytes = 0;
  if (trashedForms.length) {
    const patterns = trashedForms.slice(0, 200).map((f: any) => ({ path: { $regex: new RegExp(`(^|[\\\\/])${f._id}[\\\\/]`) } }));
    const uploads = await Upload.find({ $or: patterns }).select("size").lean();
    storageBytes = uploads.reduce((sum, u: any) => sum + (u.size || 0), 0);
  }

  const total = items.length;
  const start = (page - 1) * limit;
  return { items: items.slice(start, start + limit), total, page, limit, storageBytes };
};

// ---------------------------------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------------------------------

export const restoreItem = async (scope: TrashScope, type: TrashType, id: string): Promise<{ type: TrashType; id: string }> => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw httpError(404, "Item not found");

  if (type === "form") {
    if (!canTrashForms(scope)) throw httpError(403, "Only an Owner can restore a form", "FORBIDDEN_INSUFFICIENT_PERMISSIONS");
    const form = await Form.findOne({ ...formScopeFilter(scope), _id: id, deletedAt: { $ne: null } }).setOptions({ includeDeleted: true });
    if (!form) throw httpError(404, "Item not found");
    // Restoring the form brings back everything inside it - its responses were never touched.
    await Form.updateOne({ _id: form._id }, { $set: { deletedAt: null, deletedBy: null } });
    await logEvent(scope, form, "form.restore", form._id.toString(), form.title);
    return { type, id };
  }

  if (!canTrashResponses(scope)) throw httpError(403, "Only an Owner or Admin can restore a response", "FORBIDDEN_INSUFFICIENT_PERMISSIONS");
  const response = await ResponseModel.findById(id);
  if (!response || !response.deletedAt) throw httpError(404, "Item not found");
  const liveForm = await Form.findOne({ ...formScopeFilter(scope), _id: response.formId });
  if (!liveForm) {
    const trashedForm = await Form.findOne({ ...formScopeFilter(scope), _id: response.formId }).setOptions({ includeDeleted: true });
    if (trashedForm) {
      throw httpError(409, `Restore the form "${trashedForm.title}" first - this response is inside it`, "FORM_IN_TRASH");
    }
    throw httpError(404, "Item not found");
  }
  await ResponseModel.updateOne({ _id: response._id }, { $set: { deletedAt: null, deletedBy: null } });
  await logEvent(scope, liveForm, "response.restore", response._id.toString(), response.reference || response._id.toString());
  return { type, id };
};

// ---------------------------------------------------------------------------------------------------
// Permanent removal
// ---------------------------------------------------------------------------------------------------

// Removes one response and everything hanging off it. Used by Trash and by the retention sweep.
export const purgeResponse = async (response: Pick<IResponse, "_id" | "formId">): Promise<void> => {
  const id = response._id.toString();
  await deleteResponseFiles(id, response.formId.toString());
  await Promise.all([
    Note.deleteMany({ responseId: response._id }),
    ScoreEntry.deleteMany({ responseId: response._id }),
    ResponseReadState.deleteMany({ responseId: response._id }),
    RespondentLink.deleteMany({ responseId: response._id }),
  ]);
  await ResponseModel.deleteOne({ _id: response._id });
};

export const purgeItem = async (scope: TrashScope, type: TrashType, id: string): Promise<void> => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw httpError(404, "Item not found");

  if (type === "form") {
    if (!canTrashForms(scope)) throw httpError(403, "Only an Owner can permanently delete a form", "FORBIDDEN_INSUFFICIENT_PERMISSIONS");
    const form = await Form.findOne({ ...formScopeFilter(scope), _id: id, deletedAt: { $ne: null } }).setOptions({ includeDeleted: true });
    if (!form) throw httpError(404, "Item not found");
    await formService.purgeForm(form._id.toString());
    await logEvent(scope, form, "form.purge", form._id.toString(), form.title);
    return;
  }

  if (!canTrashResponses(scope)) throw httpError(403, "Only an Owner or Admin can permanently delete a response", "FORBIDDEN_INSUFFICIENT_PERMISSIONS");
  const response = await ResponseModel.findById(id);
  if (!response || !response.deletedAt) throw httpError(404, "Item not found");
  const form = await Form.findOne({ ...formScopeFilter(scope), _id: response.formId }).setOptions({ includeDeleted: true });
  if (!form) throw httpError(404, "Item not found");
  await purgeResponse(response);
  await logEvent(scope, form, "response.purge", id, response.reference || id);
};

// Empty trash: everything this caller is allowed to purge, in this context. Reports what it removed.
export const emptyTrash = async (scope: TrashScope): Promise<{ forms: number; responses: number }> => {
  let forms = 0;
  let responses = 0;

  if (canTrashForms(scope)) {
    const trashed = await Form.find({ ...formScopeFilter(scope), deletedAt: { $ne: null } }).setOptions({ includeDeleted: true });
    for (const form of trashed) {
      await formService.purgeForm(form._id.toString());
      await logEvent(scope, form, "form.purge", form._id.toString(), form.title);
      forms++;
    }
  }

  if (canTrashResponses(scope)) {
    const live = await Form.find(formScopeFilter(scope)).select("_id workspaceId").lean();
    if (live.length) {
      const trashed = await ResponseModel.find({ formId: { $in: live.map((f: any) => f._id) }, deletedAt: { $ne: null } });
      for (const response of trashed) {
        await purgeResponse(response);
        responses++;
      }
    }
  }
  return { forms, responses };
};

// ---------------------------------------------------------------------------------------------------
// Retention sweep (CF5.5): permanently removes anything that has sat in Trash past the retention window.
// ---------------------------------------------------------------------------------------------------

// Runs on the same 5-minute timer as closeExpiredForms (server.ts) - the repo has no job runner. It is
// safe to run on several instances at once: every step is idempotent (deleting what is already gone is a
// no-op) and the batch is bounded so a backlog can never hold the event loop. It only ever looks at
// `deletedAt`, so Archived forms - which never expire - are untouchable by construction.
export const purgeExpiredTrash = async (
  now: Date = new Date(),
  batchSize = 50
): Promise<{ forms: number; responses: number }> => {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
  let forms = 0;
  let responses = 0;

  const expiredForms = await Form.find({ deletedAt: { $ne: null, $lt: cutoff } })
    .setOptions({ includeDeleted: true })
    .select("_id title workspaceId")
    .limit(batchSize)
    .lean();
  for (const form of expiredForms) {
    try {
      await formService.purgeForm(String(form._id));
      if (form.workspaceId) {
        await logWorkspaceEvent({
          workspaceId: form.workspaceId,
          actor: { id: null, email: "system@beginso", name: "Retention sweep" },
          action: "form.purge",
          targetId: String(form._id),
          targetType: "form",
          targetLabel: form.title,
          metadata: { reason: "retention" },
        });
      }
      forms++;
    } catch (err) {
      console.error(`Retention purge of form ${form._id} failed:`, err);
    }
  }

  // Responses deleted on their own and past the window - only those whose form is live (the rest went
  // with their form above, or will on a later pass).
  const expiredResponses = await ResponseModel.find({ deletedAt: { $ne: null, $lt: cutoff } })
    .setOptions({ includeTest: true })
    .limit(batchSize);
  for (const response of expiredResponses) {
    try {
      await purgeResponse(response);
      responses++;
    } catch (err) {
      console.error(`Retention purge of response ${response._id} failed:`, err);
    }
  }
  return { forms, responses };
};
