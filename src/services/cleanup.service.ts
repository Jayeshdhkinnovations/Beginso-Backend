import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { getAuth } from "firebase-admin/auth";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";
import FormAccessGrant from "../models/FormAccessGrant";
import FormPin from "../models/FormPin";
import SavedChart from "../models/SavedChart";
import Invitation from "../models/Invitation";
import Report from "../models/Report";
import Notification from "../models/Notification";
import Membership from "../models/Membership";
import Workspace from "../models/Workspace";
import SessionModel from "../models/Session";
import User from "../models/User";
import { getUploadDir } from "../controllers/upload.controller";

// Single place that knows how to delete tenant data without leaving orphans. Files live at
// <uploadDir>/<ownerUserId>/<formId>/(brand|responses/<responseId>)/<name>, and every Upload row
// stores that relative path, so form/response ownership is read from the path.
//
// Workspace events are deliberately NOT deleted: they are the audit trail (retention/erasure of
// events is a separate, still-open product decision).

const uploadRoot = (): string => path.resolve(getUploadDir());

const removeInsideUploads = (relative: string): void => {
  const target = path.resolve(uploadRoot(), relative);
  if (target.startsWith(uploadRoot() + path.sep)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
};

// Deletes the Upload rows matching `filter`, their files, and the directory tree that ends at the
// path segment `dirEndsAt` (e.g. the form or response folder), so nothing (response.json, empty
// folders) is left behind.
const removeUploads = async (filter: Record<string, unknown>, dirEndsAt?: string): Promise<void> => {
  const uploads = await Upload.find(filter);
  const dirs = new Set<string>();
  for (const up of uploads) {
    const segments = String(up.path).replace(/\\/g, "/").split("/");
    if (dirEndsAt) {
      const at = segments.indexOf(dirEndsAt);
      if (at > 0) dirs.add(segments.slice(0, at + 1).join("/"));
    }
    removeInsideUploads(segments.join("/"));
  }
  dirs.forEach(removeInsideUploads);
  if (uploads.length) await Upload.deleteMany({ _id: { $in: uploads.map((u) => u._id) } });
};

const segmentPattern = (...parts: string[]): RegExp => new RegExp(`(^|[\\\\/])${parts.join("[\\\\/]")}[\\\\/]`);

export const deleteResponseFiles = async (responseId: string, formId: string): Promise<void> => {
  await removeUploads({ path: { $regex: segmentPattern("responses", responseId) } }, responseId);
  // Responses written before Upload rows existed still have a folder on disk.
  await removeUploads({ path: { $regex: segmentPattern(formId, "responses", responseId) } }, responseId);
};

// Uploads made before files were stored under <owner>/<form>/... have a bare filename as their path
// and are linked to the form only through branding URLs and response answers.
const legacyFileNames = async (formId: string): Promise<string[]> => {
  // includeDeleted: this runs when a form in Trash is purged, and the Form query hook hides trashed forms.
  const form = await Form.findById(formId).setOptions({ includeDeleted: true }).select("fields branding").lean();
  const names = new Set<string>();
  if (form?.branding?.logoUrl) names.add(path.basename(form.branding.logoUrl));
  if (form?.branding?.coverImageUrl) names.add(path.basename(form.branding.coverImageUrl));
  const fileLabels = (form?.fields ?? []).filter((f: any) => f.type === "file_upload").map((f: any) => f.label);
  if (fileLabels.length) {
    // includeTest: a test submission's files are files too (Sprint 13) - deletion must not skip them.
    for await (const r of ResponseModel.find({ formId }).setOptions({ includeTest: true }).select("answers").lean().cursor()) {
      for (const label of fileLabels) {
        const answer: any = (r.answers as any)?.[label];
        if (answer && typeof answer === "object" && answer.fileName) names.add(path.basename(answer.fileName));
      }
    }
  }
  return [...names];
};

export const deleteFormData = async (formId: string): Promise<void> => {
  const id = String(formId);
  const legacyNames = await legacyFileNames(id);
  if (legacyNames.length) await removeUploads({ path: { $in: legacyNames } });
  await removeUploads({ path: { $regex: segmentPattern(id) } }, id);
  await ResponseModel.deleteMany({ formId: id });
  await FormAccessGrant.deleteMany({ formId: id });
  await SavedChart.deleteMany({ formId: id });
  await FormPin.deleteMany({ formId: id });
};

export const deleteWorkspaceData = async (workspaceId: mongoose.Types.ObjectId | string): Promise<void> => {
  // includeDeleted: forms sitting in Trash are still this workspace's data and must go with it.
  const forms = await Form.find({ workspaceId }).setOptions({ includeDeleted: true }).select("_id").lean();
  for (const f of forms) await deleteFormData(String(f._id));
  await Form.deleteMany({ workspaceId });

  const reports = await Report.find({ workspaceId }).select("filePath").lean();
  const reportsRoot = path.resolve(process.cwd(), "uploads");
  for (const r of reports) {
    if (!r.filePath) continue;
    const file = path.resolve(r.filePath);
    if (file.startsWith(reportsRoot + path.sep)) fs.rmSync(file, { force: true });
  }
  const exportsDir = path.join(reportsRoot, "exports");
  if (fs.existsSync(exportsDir)) {
    for (const f of fs.readdirSync(exportsDir)) {
      if (f.startsWith(`workspace_export_${workspaceId}_`)) fs.rmSync(path.join(exportsDir, f), { force: true });
    }
  }

  await Report.deleteMany({ workspaceId });
  await Invitation.deleteMany({ workspaceId });
  await Notification.deleteMany({ workspaceId });
  await Membership.deleteMany({ workspaceId });
  await User.updateMany({ workspaceId }, { $unset: { workspaceId: 1 } });
  await Workspace.deleteOne({ _id: workspaceId });
};

// Workspaces this user owns that other people still belong to. Deleting the account would strip
// those people of their workspace, so the caller must transfer ownership (or remove them) first.
export const findSharedOwnedWorkspaces = async (userId: mongoose.Types.ObjectId) => {
  const owned = await Workspace.find({ owner: userId }).select("_id name").lean();
  const shared: { id: string; name: string; otherMembers: number }[] = [];
  for (const ws of owned) {
    const otherMembers = await Membership.countDocuments({ workspaceId: ws._id, userId: { $ne: userId } });
    if (otherMembers > 0) shared.push({ id: String(ws._id), name: ws.name, otherMembers });
  }
  return shared;
};

// Everything that belongs to one account: the workspaces it owns alone, its personal forms, its
// memberships, sessions, notifications, files, and finally the user row.
export const deleteAccountData = async (user: any): Promise<void> => {
  const userId = user._id;

  const owned = await Workspace.find({ owner: userId }).select("_id").lean();
  for (const ws of owned) await deleteWorkspaceData(ws._id);

  const personalForms = await Form.find({
    createdBy: userId,
    $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }],
  })
    .setOptions({ includeDeleted: true })
    .select("_id")
    .lean();
  for (const f of personalForms) await deleteFormData(String(f._id));
  await Form.deleteMany({ _id: { $in: personalForms.map((f) => f._id) } });

  await Membership.deleteMany({ userId });
  await FormAccessGrant.deleteMany({ userId });
  await FormPin.deleteMany({ userId });
  await Invitation.deleteMany({ email: String(user.email).toLowerCase(), status: "pending" });
  await SessionModel.deleteMany({ userId });
  await Notification.deleteMany({ userId });

  await removeUploads({ owner: userId });
  removeInsideUploads(String(userId));

  await User.deleteOne({ _id: userId });
};

// Proof that the person at the keyboard just typed their password: a Firebase ID token issued by a
// fresh sign-in for THIS user. A stolen session cookie alone must not be able to close an account.
export type ReauthResult = { ok: true } | { ok: false; code: string; message: string };

export const verifyRecentReauth = async (user: any, token: unknown): Promise<ReauthResult> => {
  if (typeof token !== "string" || !token) {
    return { ok: false, code: "REAUTH_REQUIRED", message: "Confirm your password to continue." };
  }
  try {
    const decoded = await getAuth().verifyIdToken(token);
    if (decoded.uid !== user.firebaseUid) {
      return { ok: false, code: "REAUTH_MISMATCH", message: "That confirmation belongs to a different account." };
    }
    const ageSeconds = Date.now() / 1000 - Number(decoded.auth_time ?? 0);
    if (!(ageSeconds >= -60 && ageSeconds <= 300)) {
      return { ok: false, code: "REAUTH_EXPIRED", message: "Your password confirmation expired. Please try again." };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "REAUTH_INVALID", message: "Could not verify your password confirmation." };
  }
};
