import crypto from "crypto";
import mongoose from "mongoose";
import Form, { IForm } from "../models/Form";
import ResponseModel, { IResponse } from "../models/Response";
import RespondentLink, { IRespondentLink } from "../models/RespondentLink";
import ResponseReadState from "../models/ResponseReadState";
import Notification from "../models/Notification";
import User from "../models/User";
import Workspace from "../models/Workspace";
import { FormService } from "./form.service";
import { mailService } from "./mail.service";
import { logWorkspaceEvent } from "./event.service";
import { keyedHash } from "../utils/pepper";
import { buildSearchText } from "../utils/responseSearch";
import { getAccessMode } from "../utils/accessMode";

// Sprint 13, BE 0.10 / 0.12 (A5.1-A5.4). Everything a respondent can do to a response they own, whether
// they hold a signed link or a signed-in account. Three rules shape it:
//  1. ONE token = ONE response. Nothing here can reach another respondent's data, and nothing returned
//     here ever contains workflow state: no stage name, tag, assignee, note or score (B6.5/B6.6).
//  2. Edits are judged by the same validator a submission is (FormService.validateAnswers).
//  3. A token that never existed, was revoked, or was rotated away is indistinguishable (invalid).

const formService = new FormService();

export type RespondentStatus = "Received" | "In review" | "Completed" | "Edited";
export type LinkState = "valid" | "expired" | "used" | "invalid";
export type ReadOnlyReason = "closed" | "archived" | "trashed" | "finalised";

// OQ-7 (a): 14 days by default, tunable without a deploy.
export const respondentLinkLifetimeMs = (): number => {
  const days = Number(process.env.RESPONDENT_LINK_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 14) * 24 * 60 * 60 * 1000;
};

const appUrl = (): string => process.env.APP_URL || "https://beginso.com";

export const hashToken = (token: string): string => keyedHash(`respondent-link:${token}`);

const httpError = (statusCode: number, message: string, code?: string): Error => {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
};

// What a respondent may be told about where their submission is. Derived from the stage CATEGORY that
// Sprint 12 keeps synced onto `status` - never from a stage name or id (B6.6).
export const respondentStatusOf = (response: Pick<IResponse, "status" | "editedAfterReviewAt">): RespondentStatus => {
  if (response.editedAfterReviewAt) return "Edited";
  if (response.status === "completed") return "Completed";
  if (response.status === "in_progress") return "In review";
  return "Received";
};

// OQ-7 (b): a response is "already reviewed" once it has left the first stage category OR any member has
// opened it. Both signals already exist (Sprint 12), so no new state is needed to answer it.
export const hasBeenReviewed = async (response: IResponse): Promise<boolean> => {
  if (response.status && response.status !== "new") return true;
  return !!(await ResponseReadState.exists({ responseId: response._id }));
};

// ---------------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------------

// Issues a fresh link for a response. Any earlier link for the same response is revoked, so a rotated
// link can never be replayed (B6.1). The raw token is returned ONCE and never stored.
export const issueLink = async (params: {
  responseId: mongoose.Types.ObjectId | string;
  formId: mongoose.Types.ObjectId | string;
  email: string;
}): Promise<{ token: string; expiresAt: Date }> => {
  await RespondentLink.updateMany({ responseId: params.responseId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + respondentLinkLifetimeMs());
  await RespondentLink.create({
    tokenHash: hashToken(token),
    responseId: params.responseId,
    formId: params.formId,
    email: params.email.trim().toLowerCase(),
    expiresAt,
  });
  return { token, expiresAt };
};

export const linkUrl = (token: string): string => `${appUrl()}/r/${token}`;

// Sends the signed-link email for a tracked submission. Never throws: a failed email must not fail the
// submission. The email contains no response data (respondentMail.ts).
export const sendSubmissionLink = async (params: {
  responseId: mongoose.Types.ObjectId | string;
  formId: mongoose.Types.ObjectId | string;
  formName: string;
  email: string;
}): Promise<void> => {
  try {
    const { token, expiresAt } = await issueLink({ responseId: params.responseId, formId: params.formId, email: params.email });
    await mailService.sendMail({
      to: params.email,
      template: "respondent_submission_link",
      actionUrl: linkUrl(token),
      formName: params.formName,
      expiresAt,
    });
  } catch (err) {
    console.error("Failed to send respondent link email:", err);
  }
};

interface ResolvedLink {
  state: LinkState;
  link?: IRespondentLink;
}

export const resolveLink = async (token: unknown): Promise<ResolvedLink> => {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return { state: "invalid" };
  const link = await RespondentLink.findOne({ tokenHash: hashToken(token) });
  if (!link || link.revokedAt) return { state: "invalid" };
  if (link.claimedAt) return { state: "used", link };
  if (link.expiresAt.getTime() < Date.now()) return { state: "expired", link };
  return { state: "valid", link };
};

// ---------------------------------------------------------------------------------------------------
// Reading and editing a response as its respondent
// ---------------------------------------------------------------------------------------------------

interface RespondentContext {
  response: IResponse;
  form: IForm;
}

const loadContext = async (responseId: mongoose.Types.ObjectId | string): Promise<RespondentContext | null> => {
  const response = await ResponseModel.findById(responseId); // by id: test responses stay reachable
  if (!response || response.deletedAt) return null;
  // includeDeleted: a trashed form's submission is still shown to its respondent, read-only.
  const form = await Form.findById(response.formId).setOptions({ includeDeleted: true });
  if (!form) return null;
  return { response, form };
};

// Why this submission cannot be edited right now, or null when it can (OQ-7 (c): locked once it reaches
// a *completed* stage category).
export const readOnlyReasonFor = (form: IForm, response: IResponse): ReadOnlyReason | null => {
  if (form.deletedAt) return "trashed";
  if (form.archivedAt) return "archived";
  if (form.status === "closed") return "closed";
  if (response.status === "completed") return "finalised";
  return null;
};

const fileNameOf = (value: any): string => {
  const raw = typeof value === "string" ? value : value?.fileName;
  if (typeof raw !== "string") return "";
  return decodeURIComponent(raw.split("?")[0].split("/").pop() || "");
};

// The respondent's OWN answers, in form order. File answers are reduced to a file name: their URL
// belongs to the member download path and is not a respondent capability.
const answersView = (form: IForm, response: IResponse) => {
  const pageOrder = new Map((form.pages ?? []).map((p) => [p.id, p.order]));
  const fields = (form.fields ?? [])
    .filter((f) => !f.deleted)
    .sort((a, b) => (pageOrder.get(a.pageId ?? "") ?? 0) - (pageOrder.get(b.pageId ?? "") ?? 0));
  const answers: Record<string, any> = (response.answers as any) ?? {};
  return fields.map((f) => {
    const raw = answers[f.label] ?? (f.fieldId ? answers[f.fieldId] : undefined);
    return {
      fieldId: f.fieldId,
      label: f.label,
      type: f.type,
      value: f.type === "file_upload" ? fileNameOf(raw) : raw ?? null,
      // Enough for a respondent to correct an answer with the right control. These are the form's own PUBLIC
      // definition (the same things the public form already shows), never anything about the response.
      required: !!f.required,
      ...(f.options && f.options.length ? { options: f.options } : {}),
    };
  });
};

export const viewViaLink = async (token: unknown) => {
  const { state, link } = await resolveLink(token);
  if (state === "invalid" || !link) return { httpStatus: 404, body: { state: "invalid" as const } };

  const ctx = await loadContext(link.responseId);
  if (!ctx) return { httpStatus: 404, body: { state: "invalid" as const } };
  const { form, response } = ctx;

  // The public slug is not a secret (it is the form's public link) and lets the respondent ask for a fresh link.
  const formSlug = form.publishedSlug ?? undefined;
  if (state === "expired") return { httpStatus: 410, body: { state: "expired" as const, formName: form.title, formSlug } };
  if (state === "used") {
    // After the account is created the signed-in portal is the way in; the link stops exposing data.
    return { httpStatus: 200, body: { state: "used" as const, formName: form.title, accountExists: true, formSlug } };
  }

  link.lastUsedAt = new Date();
  await link.save();

  const reason = readOnlyReasonFor(form, response);
  return {
    httpStatus: 200,
    body: {
      state: "valid" as const,
      formName: form.title,
      formSlug,
      submittedAt: response.submittedAt,
      expiresAt: link.expiresAt,
      canEdit: reason === null,
      readOnlyReason: reason ?? undefined,
      status: respondentStatusOf(response),
      fields: answersView(form, response),
      accountExists: !!(await User.exists({ email: link.email })),
      email: link.email,
    },
  };
};

// Applies a respondent's corrections. `incoming` maps fieldId -> new value. Only non-file, existing
// fields are changeable here; everything is re-validated by the form's own rules.
export const editResponse = async (
  ctx: RespondentContext,
  incoming: Record<string, unknown>
): Promise<{ editedAfterReview: boolean }> => {
  const { form, response } = ctx;
  const reason = readOnlyReasonFor(form, response);
  if (reason) throw httpError(409, `This submission can no longer be edited (${reason}).`, "SUBMISSION_READ_ONLY");

  const merged: Record<string, any> = { ...((response.answers as any) ?? {}) };
  let changed = false;
  for (const field of form.fields ?? []) {
    if (field.deleted || !field.fieldId || field.type === "file_upload") continue;
    if (!Object.prototype.hasOwnProperty.call(incoming, field.fieldId)) continue;
    merged[field.label] = incoming[field.fieldId];
    changed = true;
  }
  if (!changed) throw httpError(422, "There is nothing to change.", "NO_CHANGES");

  formService.validateAnswers(form, merged);

  const reviewed = await hasBeenReviewed(response);
  const now = new Date();
  const set: Record<string, unknown> = {
    answers: merged,
    searchText: buildSearchText(merged),
    lastEditedByRespondentAt: now,
  };
  if (reviewed) set.editedAfterReviewAt = now;
  // Stage, assignee, tags, notes and score are deliberately NOT touched by a respondent edit (B6.4).
  await ResponseModel.updateOne({ _id: response._id }, { $set: set });

  if (reviewed) await notifyEditedAfterReview(form, response);
  return { editedAfterReview: reviewed };
};

const notifyEditedAfterReview = async (form: IForm, response: IResponse): Promise<void> => {
  if (!form.workspaceId) return; // a personal form has no workspace to attach a notification to
  const ref = response.reference || response._id.toString().slice(-6);
  try {
    await logWorkspaceEvent({
      workspaceId: form.workspaceId,
      actor: { id: null, email: "respondent@public", name: "Respondent" },
      action: "response.edit_after_review",
      targetId: response._id.toString(),
      targetType: "response",
      targetLabel: ref,
    });

    // The assignee hears first; an unassigned response goes to the workspace owner. In-app only - email
    // notifications arrive with Sprint 14 (R1).
    let userId: mongoose.Types.ObjectId | null = response.assigneeId ?? null;
    if (!userId) {
      const ws = await Workspace.findById(form.workspaceId).select("owner").lean();
      userId = (ws?.owner as any) ?? null;
    }
    if (!userId) return;
    await Notification.create({
      userId,
      workspaceId: form.workspaceId,
      type: "response_edited",
      title: "Response edited after review",
      message: `A respondent edited response ${ref} on "${form.title}" after it was reviewed.`,
    });
  } catch (err) {
    console.warn("Failed to write edited-after-review notification:", err);
  }
};

export const editViaLink = async (token: unknown, incoming: Record<string, unknown>) => {
  const { state, link } = await resolveLink(token);
  if (state === "invalid" || !link) throw httpError(404, "Link not found", "LINK_INVALID");
  if (state === "expired") throw httpError(410, "This link has expired", "LINK_EXPIRED");
  if (state === "used") throw httpError(409, "Sign in to edit this submission", "LINK_USED");
  const ctx = await loadContext(link.responseId);
  if (!ctx) throw httpError(404, "Link not found", "LINK_INVALID");
  return editResponse(ctx, incoming);
};

// ---------------------------------------------------------------------------------------------------
// Claiming: the ONLY way a respondent gets an account from a submission (A5.3)
// ---------------------------------------------------------------------------------------------------

// Links a respondent's tracked submissions to the account they just created FROM the link. Requires the
// signed-in email to match the address the link was sent to, and works once per link.
export const claimViaLink = async (token: unknown, user: { _id: any; email: string }): Promise<{ linked: number }> => {
  const { state, link } = await resolveLink(token);
  if (state === "invalid" || !link) throw httpError(404, "Link not found", "LINK_INVALID");
  if (state === "expired") throw httpError(410, "This link has expired", "LINK_EXPIRED");
  if (state === "used") throw httpError(409, "This link has already been used to create an account", "LINK_USED");
  if (String(user.email).trim().toLowerCase() !== link.email) {
    throw httpError(409, "Sign in with the email address this link was sent to", "EMAIL_MISMATCH");
  }

  // Atomic: of two concurrent claims, only one flips claimedAt from null.
  const claimed = await RespondentLink.findOneAndUpdate(
    { _id: link._id, claimedAt: null },
    { $set: { claimedAt: new Date(), claimedByUserId: user._id } }
  );
  if (!claimed) throw httpError(409, "This link has already been used to create an account", "LINK_USED");

  // Only submissions that were tracked for this address (they have a link for it) - never a response that
  // merely happens to contain the same text in an email field.
  const trackedIds = await RespondentLink.distinct("responseId", { email: link.email });
  const result = await ResponseModel.updateMany(
    { _id: { $in: trackedIds }, respondentUserId: null },
    { $set: { respondentUserId: user._id } }
  );
  return { linked: result.modifiedCount };
};

// "Send me a new link". Always the same outcome whether or not anything matches, so it cannot be used to
// discover who has submitted what (B6.7). Mails the link for the address's most recent tracked submission
// to that form.
export const resendLink = async (email: unknown, slug: unknown): Promise<void> => {
  if (typeof email !== "string" || typeof slug !== "string") return;
  const address = email.trim().toLowerCase();
  if (!address) return;
  try {
    const form = await Form.findOne({ publishedSlug: slug });
    if (!form || getAccessMode(form) !== "tracked") return;
    const response = await ResponseModel.findOne({ formId: form._id, respondentEmail: address, deletedAt: null })
      .sort({ submittedAt: -1 });
    if (!response) return;
    await sendSubmissionLink({ responseId: response._id, formId: form._id, formName: form.title, email: address });
  } catch (err) {
    console.error("Failed to resend respondent link:", err);
  }
};

// ---------------------------------------------------------------------------------------------------
// The signed-in portal (My Submissions)
// ---------------------------------------------------------------------------------------------------

export const listMine = async (userId: mongoose.Types.ObjectId | string) => {
  const responses = await ResponseModel.find({ respondentUserId: userId, deletedAt: null }).sort({ submittedAt: -1 }).limit(500);
  const formIds = [...new Set(responses.map((r) => String(r.formId)))];
  // Default Form query: a trashed form's submissions drop out of the portal until it is restored.
  const forms = await Form.find({ _id: { $in: formIds } });
  const formById = new Map(forms.map((f) => [String(f._id), f]));

  const workspaceIds = [...new Set(forms.map((f) => (f.workspaceId ? String(f.workspaceId) : "")).filter(Boolean))];
  const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).select("name").lean();
  const workspaceName = new Map(workspaces.map((w) => [String(w._id), w.name]));

  return responses
    .filter((r) => formById.has(String(r.formId)))
    .map((r) => {
      const form = formById.get(String(r.formId))!;
      return {
        id: r._id.toString(),
        formName: form.title,
        ownerName: form.workspaceId ? workspaceName.get(String(form.workspaceId)) ?? "" : "",
        submittedAt: r.submittedAt,
        status: respondentStatusOf(r),
        canEdit: readOnlyReasonFor(form, r) === null,
      };
    });
};

// One of MY submissions, or null. Ownership is the whole check: someone else's id is simply "not found".
const loadMine = async (responseId: string, userId: mongoose.Types.ObjectId | string): Promise<RespondentContext | null> => {
  if (!mongoose.Types.ObjectId.isValid(responseId)) return null;
  const ctx = await loadContext(responseId);
  if (!ctx || String(ctx.response.respondentUserId) !== String(userId)) return null;
  return ctx;
};

export const detailMine = async (responseId: string, userId: mongoose.Types.ObjectId | string) => {
  const ctx = await loadMine(responseId, userId);
  if (!ctx) return null;
  const reason = readOnlyReasonFor(ctx.form, ctx.response);
  return {
    id: ctx.response._id.toString(),
    formName: ctx.form.title,
    submittedAt: ctx.response.submittedAt,
    status: respondentStatusOf(ctx.response),
    canEdit: reason === null,
    readOnlyReason: reason ?? undefined,
    fields: answersView(ctx.form, ctx.response),
  };
};

export const editMine = async (responseId: string, userId: mongoose.Types.ObjectId | string, incoming: Record<string, unknown>) => {
  const ctx = await loadMine(responseId, userId);
  if (!ctx) throw httpError(404, "Submission not found");
  return editResponse(ctx, incoming);
};
