/**
 * src/mail/templates.ts
 *
 * The twelve templates Beginso was missing, as pure render functions over the
 * shared layout. Same shape as respondentMail.ts and notificationMail.ts:
 * data in, {subject, text, html} out, no transport and no I/O — so each one is
 * unit-testable and the rules that matter are provable rather than hoped for.
 *
 * ── Integration ───────────────────────────────────────────────────────────────
 *
 * 1. Extend the union in mailService.ts:
 *
 *      export type AuthMailType =
 *        | "verify_email" | "verify_email_otp" | "reset_password"
 *        | "welcome_user" | "email_verified_success" | "password_changed_success"
 *        | "workspace_invitation" | "respondent_submission_link"
 *        | "activity_notification"
 *        // new
 *        | "role_changed" | "member_removed" | "invitation_accepted"
 *        | "invitation_reminder" | "form_shared" | "export_ready"
 *        | "export_failed" | "response_limit_reached" | "new_device_signin"
 *        | "respondent_receipt" | "weekly_digest" | "workspace_deleted";
 *
 * 2. Carry a typed payload per template rather than widening SendMailOptions with
 *    another twenty optional fields. SendMailOptions is already 14 optionals deep
 *    and nothing stops a caller passing `code` to an export email:
 *
 *      type MailPayload =
 *        | { template: "role_changed"; data: RoleChangedInput }
 *        | { template: "export_ready"; data: ExportReadyInput }
 *        | ...
 *
 *    Then the dispatch is a lookup, and the 560-line if/else chain disappears:
 *
 *      const RENDERERS = {
 *        role_changed: renderRoleChangedEmail,
 *        export_ready: renderExportReadyEmail,
 *        // ...
 *      } as const;
 *
 *      const rendered = RENDERERS[payload.template](payload.data as never);
 *      if (!rendered) throw new Error(`No renderer for template ${payload.template}`);
 *
 *    Throwing matters: today an unrecognised template falls through every branch
 *    and sends a completely blank email.
 *
 * 3. Classification for List-Unsubscribe. Transactional mail must NOT carry it:
 *
 *      const BULK: ReadonlySet<AuthMailType> = new Set([
 *        "activity_notification", "weekly_digest",
 *        "invitation_accepted", "form_shared", "response_limit_reached",
 *      ]);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  APP_URL, C, FONT, RenderedMail,
  button, detailCard, esc, escUrl, formatDate, formatDay,
  heading, layout, linkFallback, notice, paragraph, relativeUntil,
} from "./layout";

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Editor",
  editor: "Editor",
  viewer: "Reviewer",
  reviewer: "Reviewer",
};

/** Keep one role vocabulary between app and email, or users see two names for one thing. */
function roleLabel(role: string): string {
  return ROLE_LABELS[String(role).toLowerCase()] ?? "Member";
}

// ═════════════════════════════════════════════════════════════════════════════
// 1 · Role changed  — TRANSACTIONAL
//
// The urgent one. A role change currently revokes every session that member
// has, with no message, so they are silently signed out mid-task and have no
// idea why. This email is the explanation for something the product already does.
// ═════════════════════════════════════════════════════════════════════════════

export interface RoleChangedInput {
  workspaceName: string;
  workspaceSlug: string;
  oldRole: string;
  newRole: string;
  changedByName: string;
  /** True when the change invalidated the member's sessions. */
  sessionsRevoked: boolean;
}

export function renderRoleChangedEmail(i: RoleChangedInput): RenderedMail {
  const from = roleLabel(i.oldRole);
  const to = roleLabel(i.newRole);
  const url = `${APP_URL}/w/${encodeURIComponent(i.workspaceSlug)}`;

  const subject = `Your role in ${i.workspaceName} is now ${to}`;
  const signedOut = i.sessionsRevoked
    ? "You have been signed out on all your devices. Sign in again to continue."
    : "";

  const text = `Your role changed

${i.changedByName} changed your role in ${i.workspaceName} from ${from} to ${to}.

${signedOut}

See what ${to} can do: ${APP_URL}/w/${i.workspaceSlug}/roles

Open the workspace: ${url}`;

  return {
    subject,
    text,
    html: layout({
      preheader: i.sessionsRevoked
        ? `You are now ${to} — and signed out on all devices`
        : `You are now ${to} in ${i.workspaceName}`,
      accent: "brand",
      content: `
${heading("Your role changed")}
${paragraph(`<strong>${esc(i.changedByName)}</strong> changed your role in <strong>${esc(i.workspaceName)}</strong>.`)}
${detailCard([
  { label: "Workspace", value: i.workspaceName },
  { label: "Previous role", value: from },
  { label: "New role", value: to, badge: true },
])}
${
  i.sessionsRevoked
    ? notice(
        `<strong>You have been signed out everywhere.</strong> Changing a role ends all existing sessions, so you will need to sign in again on each device.`,
        "warning"
      )
    : ""
}
${button("Open workspace", url)}
${paragraph(
  `Not sure what changed? <a href="${escUrl(`${APP_URL}/w/${i.workspaceSlug}/roles`)}" style="color: ${C.primaryDeep};">See what a ${esc(to)} can do</a>.`,
  0
)}`,
      footerNote: `Sent because your access to ${esc(i.workspaceName)} changed.`,
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2 · Export ready  — TRANSACTIONAL
//
// Reports are async and the files expire. The Exports page says "you can leave
// this page and come back" but nothing tells the user when, so a file they
// waited for can expire unseen.
// ═════════════════════════════════════════════════════════════════════════════

export interface ExportReadyInput {
  format: "CSV" | "PDF";
  formName?: string;          // omitted means all forms
  rowCount: number;
  fileSizeBytes?: number;
  downloadUrl: string;
  expiresAt: Date;
  timeZone?: string;
}

function fileSize(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return `${n < 10 && u > 0 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

export function renderExportReadyEmail(i: ExportReadyInput): RenderedMail {
  const scope = i.formName ? i.formName : "All forms";
  const size = fileSize(i.fileSizeBytes);
  const expiry = formatDate(i.expiresAt, i.timeZone);
  const rel = relativeUntil(i.expiresAt);

  const subject = `Your ${i.format} export is ready`;

  const text = `Your ${i.format} export is ready

Form: ${scope}
Responses: ${i.rowCount}${size ? `\nFile size: ${size}` : ""}

Download it: ${i.downloadUrl}

This file is deleted ${rel} (${expiry}). Generate a new export any time from ${APP_URL}/exports.`;

  return {
    subject,
    text,
    html: layout({
      preheader: `${i.rowCount} response${i.rowCount === 1 ? "" : "s"} — the file is deleted ${rel}`,
      accent: "success",
      content: `
${heading(`Your ${i.format} export is ready`)}
${paragraph("The file is generated and waiting for you.")}
${detailCard([
  { label: "Form", value: scope },
  { label: "Responses", value: String(i.rowCount) },
  ...(size ? [{ label: "File size", value: size }] : []),
  { label: "Available until", value: expiry },
])}
${button(`Download ${i.format}`, i.downloadUrl, "success")}
${linkFallback(i.downloadUrl)}
${notice(`This file is deleted <strong>${esc(rel)}</strong>. You can generate a new export at any time — nothing is lost.`, "neutral")}`,
      footerNote: "Sent because you generated an export.",
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 3 · Export failed  — TRANSACTIONAL
//
// PDF generation has broken in production before. A silent failure on an async
// job is indistinguishable from a slow one.
// ═════════════════════════════════════════════════════════════════════════════

export interface ExportFailedInput {
  format: "CSV" | "PDF";
  formName?: string;
  /** User-safe reason only. Never pass a raw stack or provider error. */
  reason?: string;
  retryUrl: string;
}

export function renderExportFailedEmail(i: ExportFailedInput): RenderedMail {
  const scope = i.formName ? i.formName : "All forms";
  const subject = `Your ${i.format} export could not be generated`;

  const text = `Your ${i.format} export failed

Form: ${scope}
${i.reason ? `Reason: ${i.reason}\n` : ""}
Nothing was lost — your responses are untouched. Try again: ${i.retryUrl}

If it fails a second time, reply to this email and we will look into it.`;

  return {
    subject,
    text,
    html: layout({
      preheader: "Nothing was lost — your responses are untouched",
      accent: "danger",
      content: `
${heading(`Your ${i.format} export could not be generated`)}
${paragraph(`We could not build the export for <strong>${esc(scope)}</strong>.`)}
${i.reason ? notice(`<strong>What went wrong:</strong> ${esc(i.reason)}`, "danger") : ""}
${paragraph("Your responses are untouched — this only affected the file we were building.")}
${button("Try again", i.retryUrl)}
${paragraph("If it fails a second time, reply to this email and we will look into it for you.", 0)}`,
      footerNote: "Sent because an export you requested did not complete.",
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 4 · Invitation accepted  — NOTIFICATION (needs List-Unsubscribe)
//
// You send the invite but never close the loop for the person who sent it.
// ═════════════════════════════════════════════════════════════════════════════

export interface InvitationAcceptedInput {
  memberName: string;
  memberEmail: string;
  role: string;
  workspaceName: string;
  workspaceSlug: string;
  unsubscribeUrl: string;
}

export function renderInvitationAcceptedEmail(i: InvitationAcceptedInput): RenderedMail {
  const who = i.memberName || i.memberEmail;
  const role = roleLabel(i.role);
  const teamUrl = `${APP_URL}/w/${encodeURIComponent(i.workspaceSlug)}/team`;

  return {
    subject: `${who} joined ${i.workspaceName}`,
    text: `${who} joined ${i.workspaceName}

${who} (${i.memberEmail}) accepted your invitation and is now a ${role}.

See the team: ${teamUrl}`,
    html: layout({
      preheader: `${who} is now a ${role}`,
      accent: "success",
      content: `
${heading(`${who} joined ${i.workspaceName}`)}
${paragraph(`Your invitation was accepted. They now have ${esc(role)} access.`)}
${detailCard([
  { label: "Member", value: who },
  { label: "Email", value: i.memberEmail },
  { label: "Role", value: role, badge: true },
])}
${button("View team", teamUrl, "success")}`,
      footerNote: `Sent because you invited someone to ${esc(i.workspaceName)}.`,
      unsubscribeUrl: i.unsubscribeUrl,
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 5 · Invitation reminder  — TRANSACTIONAL
//
// Invitations expire after 7 days. Send at day 3. Recovers a meaningful share
// of invites that would otherwise lapse unnoticed.
// ═════════════════════════════════════════════════════════════════════════════

export interface InvitationReminderInput {
  workspaceName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
  invitedEmail: string;
}

export function renderInvitationReminderEmail(i: InvitationReminderInput): RenderedMail {
  const role = roleLabel(i.role);
  const rel = relativeUntil(i.expiresAt);

  return {
    subject: `Reminder: your invitation to ${i.workspaceName} expires ${rel}`,
    text: `Your invitation is still waiting

${i.inviterName} invited you to join ${i.workspaceName} on Beginso as a ${role}.

This invitation expires ${rel} (${formatDay(i.expiresAt)}).

Accept it: ${i.acceptUrl}

If you were not expecting this, ignore this email and the invitation will lapse on its own.`,
    html: layout({
      preheader: `${i.inviterName} is waiting — the invitation expires ${rel}`,
      accent: "warning",
      content: `
${heading("Your invitation is still waiting")}
${paragraph(`<strong>${esc(i.inviterName)}</strong> invited you to join <strong>${esc(i.workspaceName)}</strong> as a ${esc(role)}.`)}
${detailCard([
  { label: "Workspace", value: i.workspaceName },
  { label: "Role", value: role, badge: true },
  { label: "Invited email", value: i.invitedEmail },
  { label: "Expires", value: formatDay(i.expiresAt) },
])}
${button("Accept invitation", i.acceptUrl, "warning")}
${linkFallback(i.acceptUrl)}`,
      footerNote: "If you were not expecting this, ignore this email and the invitation lapses on its own.",
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 6 · Removed from workspace  — TRANSACTIONAL
//
// Today a member loses access with no notification at all.
// ═════════════════════════════════════════════════════════════════════════════

export interface MemberRemovedInput {
  workspaceName: string;
  removedByName: string;
  /** True when they still have a personal space to fall back to (they always do). */
  hasPersonalSpace?: boolean;
}

export function renderMemberRemovedEmail(i: MemberRemovedInput): RenderedMail {
  return {
    subject: `You no longer have access to ${i.workspaceName}`,
    text: `Access removed

${i.removedByName} removed your access to the ${i.workspaceName} workspace on Beginso.

Forms and responses that belong to that workspace are no longer visible to you. Anything in your personal space is unaffected.

Your personal space: ${APP_URL}/dashboard

If you think this was a mistake, contact ${i.removedByName} or another workspace admin.`,
    html: layout({
      preheader: "Your personal space and its forms are unaffected",
      accent: "neutral",
      content: `
${heading("Access removed")}
${paragraph(`<strong>${esc(i.removedByName)}</strong> removed your access to the <strong>${esc(i.workspaceName)}</strong> workspace.`)}
${paragraph("Forms and responses belonging to that workspace are no longer visible to you. Anything in your personal space is unaffected.")}
${button("Go to your personal space", `${APP_URL}/dashboard`, "neutral")}
${notice(`If you think this was a mistake, contact ${esc(i.removedByName)} or another admin of that workspace — we cannot restore access for you.`, "neutral")}`,
      footerNote: "Sent because your workspace access changed.",
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 7 · Form shared with you  — NOTIFICATION (needs List-Unsubscribe)
//
// Per-form grants shipped in Sprint 9 and /shared exists, but nothing tells the
// grantee it happened — so the feature is invisible unless they go looking.
// ═════════════════════════════════════════════════════════════════════════════

export interface FormSharedInput {
  formName: string;
  formId: string;
  sharedByName: string;
  accessLevel: string;     // viewer | editor | reviewer
  workspaceName?: string;
  unsubscribeUrl: string;
}

export function renderFormSharedEmail(i: FormSharedInput): RenderedMail {
  const level = roleLabel(i.accessLevel);
  const url = `${APP_URL}/forms/${encodeURIComponent(i.formId)}/overview`;

  const can =
    level === "Reviewer"
      ? "You can read responses on this form."
      : level === "Editor"
      ? "You can edit this form and read its responses."
      : "You can view this form and its responses.";

  return {
    subject: `${i.sharedByName} shared "${i.formName}" with you`,
    text: `A form was shared with you

${i.sharedByName} gave you ${level} access to "${i.formName}"${i.workspaceName ? ` in ${i.workspaceName}` : ""}.

${can}

Open it: ${url}
All forms shared with you: ${APP_URL}/shared`,
    html: layout({
      preheader: `${level} access — ${can}`,
      accent: "brand",
      content: `
${heading("A form was shared with you")}
${paragraph(`<strong>${esc(i.sharedByName)}</strong> gave you access to a form${i.workspaceName ? ` in <strong>${esc(i.workspaceName)}</strong>` : ""}.`)}
${detailCard([
  { label: "Form", value: i.formName },
  ...(i.workspaceName ? [{ label: "Workspace", value: i.workspaceName }] : []),
  { label: "Your access", value: level, badge: true },
])}
${paragraph(esc(can))}
${button("Open form", url)}
${paragraph(`Everything shared with you lives at <a href="${escUrl(`${APP_URL}/shared`)}" style="color: ${C.primaryDeep};">Shared with me</a>.`, 0)}`,
      footerNote: "Sent because someone shared a form with you.",
      unsubscribeUrl: i.unsubscribeUrl,
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 8 · Response limit reached / form closed  — NOTIFICATION
//
// The one most likely to cost a user real data. Forms carry responseLimit and
// closeDate; when one trips the form stops collecting and the owner finds out
// by noticing nothing arrived.
// ═════════════════════════════════════════════════════════════════════════════

export interface ResponseLimitInput {
  formName: string;
  formId: string;
  reason: "limit" | "close_date";
  limit?: number;
  totalResponses: number;
  closedAt: Date;
  timeZone?: string;
  unsubscribeUrl: string;
}

export function renderResponseLimitEmail(i: ResponseLimitInput): RenderedMail {
  const isLimit = i.reason === "limit";
  const why = isLimit
    ? `It reached its limit of ${i.limit} responses.`
    : `It passed its scheduled close date.`;

  const subject = isLimit
    ? `"${i.formName}" stopped accepting responses — limit reached`
    : `"${i.formName}" closed as scheduled`;

  const inboxUrl = `${APP_URL}/forms/${encodeURIComponent(i.formId)}/inbox`;
  const settingsUrl = `${APP_URL}/forms/${encodeURIComponent(i.formId)}/edit?tab=behaviour`;

  return {
    subject,
    text: `${i.formName} is no longer accepting responses

${why}

Total responses collected: ${i.totalResponses}
Closed: ${formatDate(i.closedAt, i.timeZone)}

Anyone opening the form now sees a message saying it is closed. Nothing has been deleted.

Read the responses: ${inboxUrl}
${isLimit ? `Raise the limit or reopen it: ${settingsUrl}` : `Change the close date or reopen it: ${settingsUrl}`}`,
    html: layout({
      preheader: `${i.totalResponses} response${i.totalResponses === 1 ? "" : "s"} collected — nothing has been deleted`,
      accent: "warning",
      content: `
${heading(`"${i.formName}" is no longer accepting responses`)}
${paragraph(esc(why))}
${detailCard([
  { label: "Form", value: i.formName },
  { label: "Responses collected", value: String(i.totalResponses) },
  ...(isLimit && i.limit ? [{ label: "Limit", value: String(i.limit) }] : []),
  { label: "Closed", value: formatDate(i.closedAt, i.timeZone) },
])}
${notice("Anyone opening the form now sees a message saying it is closed. Nothing has been deleted.", "warning")}
${button("Read the responses", inboxUrl, "warning")}
${paragraph(
  `Need it open again? <a href="${escUrl(settingsUrl)}" style="color: ${C.primaryDeep};">${isLimit ? "Raise the limit" : "Change the close date"}</a> in the form's Behaviour settings.`,
  0
)}`,
      footerNote: "Sent because a form you own stopped collecting responses.",
      unsubscribeUrl: i.unsubscribeUrl,
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 9 · New device sign-in  — TRANSACTIONAL
//
// loginHistory already records device and approximate location, so the data is
// there. Expected of anything holding other people's form submissions.
// ═════════════════════════════════════════════════════════════════════════════

export interface NewDeviceSigninInput {
  device: string;            // "Chrome on macOS"
  approxLocation?: string;   // "Pune, Maharashtra, IN" — never a raw IP
  signedInAt: Date;
  timeZone?: string;
}

export function renderNewDeviceSigninEmail(i: NewDeviceSigninInput): RenderedMail {
  const where = i.approxLocation || "Unknown location";
  const when = formatDate(i.signedInAt, i.timeZone);

  return {
    subject: "New sign-in to your Beginso account",
    text: `New sign-in

Device: ${i.device}
Location: ${where}
Time: ${when}

If this was you, nothing to do.

If it was not you, change your password and sign out the other sessions now:
${APP_URL}/settings?tab=security`,
    html: layout({
      preheader: `${i.device} · ${where}`,
      accent: "neutral",
      content: `
${heading("New sign-in to your account")}
${paragraph("Your Beginso account was signed in on a device we have not seen before.")}
${detailCard([
  { label: "Device", value: i.device },
  { label: "Approximate location", value: where },
  { label: "Time", value: when },
])}
${paragraph("If this was you, there is nothing to do.")}
${notice(
  `<strong>If this was not you</strong>, change your password and sign out every other session straight away.`,
  "danger"
)}
${button("Review security settings", `${APP_URL}/settings?tab=security`, "danger")}`,
      footerNote: "We send this whenever your account is used on a new device. Location is approximate.",
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 10 · Respondent receipt  — TRANSACTIONAL, goes to a member of the public
//
// Typeform, Google Forms and Jotform all offer this and people look for it.
// Make it per-form opt-in in the builder's Behaviour tab.
//
// ⚠️ The input type deliberately has NO field for internal notes, tags,
// assignee, stage or score. A respondent-facing email cannot leak workspace
// context, and the shape of this function is what makes that provable — the
// same reason respondentMail.ts is a pure function.
// ═════════════════════════════════════════════════════════════════════════════

export interface RespondentReceiptInput {
  formName: string;
  /** Workspace/brand display name shown to the respondent, if branding is on. */
  brandName?: string;
  submittedAt: Date;
  timeZone?: string;
  /** Only the respondent's own answers. Never notes, tags, stage or score. */
  answers: Array<{ question: string; answer: string }>;
  /** Present only when the form allows editing a submission. */
  editUrl?: string;
  editExpiresAt?: Date;
  /** Optional support address the form owner configured. */
  contactEmail?: string;
}

export function renderRespondentReceiptEmail(i: RespondentReceiptInput): RenderedMail {
  const brand = i.brandName || "the form owner";
  const when = formatDate(i.submittedAt, i.timeZone);

  const rows = i.answers
    .map(
      (a, idx) => `
<tr><td style="padding: ${idx === 0 ? "0" : "14px"} 0 0 0; ${idx === 0 ? "" : `border-top: 1px solid ${C.lineSoft}; padding-top: 14px;`}">
  <span style="font-size: 12px; color: ${C.muted}; font-family: ${FONT}; text-transform: uppercase; letter-spacing: 0.6px;">${esc(a.question)}</span>
  <div style="font-size: 15px; color: ${C.ink}; margin-top: 4px; line-height: 1.5; font-family: ${FONT}; white-space: pre-wrap;">${esc(a.answer || "—")}</div>
</td></tr>`
    )
    .join("");

  const textAnswers = i.answers
    .map((a) => `${a.question}\n${a.answer || "—"}`)
    .join("\n\n");

  return {
    subject: `Your response to "${i.formName}"`,
    text: `Thanks — we received your response

Form: ${i.formName}
Submitted: ${when}

Your answers:

${textAnswers}
${i.editUrl ? `\nNeed to change something? ${i.editUrl}${i.editExpiresAt ? `\nThis link works until ${formatDay(i.editExpiresAt)}.` : ""}` : ""}
${i.contactEmail ? `\nQuestions about this form? Contact ${i.contactEmail}.` : ""}

This is a copy for your records. Keep it safe — it contains the answers you submitted.`,
    html: layout({
      preheader: `A copy of what you submitted to ${i.formName}`,
      accent: "success",
      content: `
${heading("Thanks — we received your response")}
${paragraph(`This is a copy of what you submitted to <strong>${esc(i.formName)}</strong>, for your records.`)}
${detailCard([
  { label: "Form", value: i.formName },
  { label: "Submitted", value: when },
])}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 24px 0;">
  <tr><td style="background-color: ${C.surfaceSub}; border: 1px solid ${C.lineSoft}; border-radius: 12px; padding: 18px 20px;">
    <p style="font-size: 12px; color: ${C.muted}; margin: 0 0 14px 0; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; font-family: ${FONT};">Your answers</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table>
  </td></tr>
</table>
${i.editUrl ? button("Change my answers", i.editUrl, "success") : ""}
${
  i.editUrl && i.editExpiresAt
    ? paragraph(`This link works until <strong>${esc(formatDay(i.editExpiresAt))}</strong>.`)
    : ""
}
${
  i.contactEmail
    ? paragraph(`Questions about this form? Contact <a href="mailto:${esc(i.contactEmail)}" style="color: ${C.primaryDeep};">${esc(i.contactEmail)}</a>.`, 0)
    : ""
}`,
      footerNote: `You received this because you submitted a form collected by ${esc(brand)} using Beginso. Keep it safe — it contains the answers you submitted.`,
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 11 · Weekly digest  — BULK (needs List-Unsubscribe and one-click)
//
// Settings already has a weekly-digest toggle with nothing behind it, so a user
// can switch it on and wait forever. Either this ships or the toggle comes out.
// ═════════════════════════════════════════════════════════════════════════════

export interface WeeklyDigestInput {
  recipientName?: string;
  periodStart: Date;
  periodEnd: Date;
  timeZone?: string;
  totalResponses: number;
  previousTotal: number;
  unreadCount: number;
  topForms: Array<{ name: string; formId: string; responses: number }>;
  /** Forms with no responses in the period and still live — worth a nudge. */
  quietForms?: Array<{ name: string; formId: string }>;
  unsubscribeUrl: string;
}

export function renderWeeklyDigestEmail(i: WeeklyDigestInput): RenderedMail {
  const span = `${formatDay(i.periodStart, i.timeZone)} – ${formatDay(i.periodEnd, i.timeZone)}`;
  const delta = i.totalResponses - i.previousTotal;

  // Only claim a percentage when the baseline can support one. A jump from
  // 1 to 4 is not "up 300%", it is noise.
  const pct =
    i.previousTotal >= 10
      ? `${delta >= 0 ? "up" : "down"} ${Math.abs(Math.round((delta / i.previousTotal) * 100))}%`
      : null;

  const trend =
    i.previousTotal === 0 && i.totalResponses === 0
      ? "No responses this week or last."
      : pct
      ? `${pct} on last week (${i.previousTotal}).`
      : `${i.previousTotal} last week.`;

  const subject =
    i.totalResponses === 0
      ? `Your week on Beginso: no new responses`
      : `Your week on Beginso: ${i.totalResponses} new response${i.totalResponses === 1 ? "" : "s"}`;

  const topRows = i.topForms
    .map(
      (f, idx) => `
<tr><td style="padding: ${idx === 0 ? "0" : "12px"} 0 0 0;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
    <td style="font-size: 14px; color: ${C.ink}; font-family: ${FONT};">
      <a href="${escUrl(`${APP_URL}/forms/${encodeURIComponent(f.formId)}/inbox`)}" style="color: ${C.ink}; text-decoration: none;">${esc(f.name)}</a>
    </td>
    <td align="right" style="font-size: 14px; font-weight: 700; color: ${C.ink}; white-space: nowrap; font-family: ${FONT};">${esc(String(f.responses))}</td>
  </tr></table>
</td></tr>`
    )
    .join("");

  const textTop = i.topForms.map((f) => `  ${f.name} — ${f.responses}`).join("\n");

  return {
    subject,
    text: `Your week on Beginso
${span}

New responses: ${i.totalResponses}
${trend}
Waiting to be read: ${i.unreadCount}

${i.topForms.length ? `Busiest forms:\n${textTop}\n` : ""}${
      i.quietForms?.length
        ? `\nLive but quiet this week:\n${i.quietForms.map((f) => `  ${f.name}`).join("\n")}\n`
        : ""
    }
Open your inbox: ${APP_URL}/inbox

Change how often you hear from us: ${APP_URL}/settings?tab=notifications`,
    html: layout({
      preheader:
        i.totalResponses === 0
          ? `Nothing new this week · ${i.unreadCount} still waiting to be read`
          : `${i.totalResponses} new · ${i.unreadCount} waiting to be read`,
      accent: "brand",
      content: `
${heading(i.recipientName ? `Your week, ${i.recipientName}` : "Your week on Beginso")}
${paragraph(`<span style="color: ${C.muted};">${esc(span)}</span>`, 22)}

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 24px 0;">
  <tr><td style="background-color: ${C.primarySoft}; border-radius: 12px; padding: 22px 20px;">
    <div style="font-size: 44px; font-weight: 700; color: ${C.ink}; line-height: 1; letter-spacing: -1px; font-family: ${FONT};">${esc(String(i.totalResponses))}</div>
    <div style="font-size: 14px; color: ${C.inkSoft}; margin-top: 6px; font-family: ${FONT};">new response${i.totalResponses === 1 ? "" : "s"} · ${esc(trend)}</div>
  </td></tr>
</table>

${
  i.unreadCount > 0
    ? notice(`<strong>${esc(String(i.unreadCount))}</strong> response${i.unreadCount === 1 ? "" : "s"} still waiting to be read.`, "info")
    : ""
}

${
  i.topForms.length
    ? `<p style="font-size: 12px; color: ${C.muted}; margin: 0 0 12px 0; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; font-family: ${FONT};">Busiest forms</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 24px 0;">${topRows}</table>`
    : ""
}

${
  i.quietForms?.length
    ? notice(
        `<strong>Live but quiet this week:</strong> ${i.quietForms.map((f) => esc(f.name)).join(", ")}. Worth checking the link still works.`,
        "neutral"
      )
    : ""
}

${button("Open inbox", `${APP_URL}/inbox`)}`,
      footerNote: "You get this every Monday because weekly digest is on in your notification settings.",
      unsubscribeUrl: i.unsubscribeUrl,
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 12 · Workspace deleted  — TRANSACTIONAL
//
// A receipt for an irreversible action. Send to the owner after deletion
// completes, with the real counts of what went.
// ═════════════════════════════════════════════════════════════════════════════

export interface WorkspaceDeletedInput {
  workspaceName: string;
  deletedByName: string;
  deletedAt: Date;
  timeZone?: string;
  formCount: number;
  responseCount: number;
  memberCount: number;
}

export function renderWorkspaceDeletedEmail(i: WorkspaceDeletedInput): RenderedMail {
  const when = formatDate(i.deletedAt, i.timeZone);

  return {
    subject: `${i.workspaceName} has been deleted`,
    text: `Workspace deleted

${i.deletedByName} deleted the ${i.workspaceName} workspace on ${when}.

Destroyed with it:
  ${i.formCount} form${i.formCount === 1 ? "" : "s"}
  ${i.responseCount} response${i.responseCount === 1 ? "" : "s"}
  ${i.memberCount} membership${i.memberCount === 1 ? "" : "s"}

This cannot be undone and we do not keep a copy.

Your personal space is unaffected: ${APP_URL}/dashboard

If you did not authorise this, reply to this email immediately.`,
    html: layout({
      preheader: "This cannot be undone — your personal space is unaffected",
      accent: "danger",
      content: `
${heading(`${i.workspaceName} has been deleted`)}
${paragraph(`<strong>${esc(i.deletedByName)}</strong> deleted this workspace on ${esc(when)}.`)}
${detailCard([
  { label: "Forms destroyed", value: String(i.formCount) },
  { label: "Responses destroyed", value: String(i.responseCount) },
  { label: "Memberships removed", value: String(i.memberCount) },
])}
${notice("This cannot be undone, and we do not keep a copy of deleted workspace data.", "danger")}
${paragraph("Your personal space and the forms in it are unaffected.")}
${button("Go to your personal space", `${APP_URL}/dashboard`, "neutral")}
${paragraph("If you did not authorise this, reply to this email immediately.", 0)}`,
      footerNote: "Sent as a receipt for an irreversible action on your account.",
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// The six original templates, moved off the 560-line inline chain in
// mail.service.ts. All TRANSACTIONAL — none carries List-Unsubscribe.
// ═════════════════════════════════════════════════════════════════════════════

export function renderVerifyEmail(i: { revealUrl: string }): RenderedMail {
  return {
    subject: "Verify your Beginso email",
    text: `Verify your email address

Open the link below to view your six-digit verification code:
${i.revealUrl}

This link and its code expire in 10 minutes.

If you did not create a Beginso account, ignore this email.`,
    html: layout({
      preheader: "Your six-digit code, valid for 10 minutes",
      content: `
${heading("Verify your email address")}
${paragraph("Click the button below to securely view your six-digit verification code.")}
${button("View verification code", i.revealUrl)}
${linkFallback(i.revealUrl)}
${notice("The code is generated only when you open the link and is shown once on the Beginso website. It expires in <strong>10 minutes</strong>.", "info")}`,
      footerNote: "If you did not create a Beginso account, ignore this email.",
    }),
  };
}

export function renderResetPasswordEmail(i: { resetUrl: string }): RenderedMail {
  return {
    subject: "Reset your Beginso password",
    text: `Reset your password

We received a request to reset your Beginso password. Create a new one here:
${i.resetUrl}

If you did not request this, ignore this email — your password stays unchanged.`,
    html: layout({
      preheader: "Create a new password — link valid for 1 hour",
      content: `
${heading("Reset your password")}
${paragraph("We received a request to reset your Beginso password. Click the button below to create a new one.")}
${button("Reset password", i.resetUrl)}
${linkFallback(i.resetUrl)}
${notice("If you did not request a password reset, your password is unchanged and you can ignore this email.", "warning")}`,
      footerNote: "If you did not request this change, you can safely ignore this email.",
    }),
  };
}

export function renderWelcomeEmail(i: { name?: string; dashboardUrl: string }): RenderedMail {
  const who = i.name || "there";
  return {
    subject: "Welcome to Beginso",
    text: `Welcome to Beginso, ${who}

Build forms, collect responses and understand them, all in one place.

Get started: ${i.dashboardUrl}

Need help? Reply to this email and a person will answer.`,
    html: layout({
      preheader: "Build your first form in about two minutes",
      content: `
${heading(`Welcome to Beginso, ${who}`)}
${paragraph("Build forms, collect responses and understand them, all in one place.")}
${detailCard([
  { label: "Form builder", value: "Multi-step forms in minutes" },
  { label: "Insights", value: "Track submissions as they arrive" },
  { label: "Security", value: "Encrypted data, strict session controls" },
])}
${button("Go to dashboard", i.dashboardUrl)}`,
      footerNote: "Need help? Reply to this email and a person will answer.",
    }),
  };
}

export function renderWorkspaceInvitationEmail(i: {
  to: string; workspaceName: string; inviterName: string; role: string; acceptUrl: string;
}): RenderedMail {
  const role = roleLabel(i.role);
  return {
    subject: `${i.inviterName} invited you to ${i.workspaceName} on Beginso`,
    text: `You have been invited to ${i.workspaceName}

${i.inviterName} invited you to collaborate in the ${i.workspaceName} workspace as ${role}.

Workspace: ${i.workspaceName}
Your role: ${role}
Invited email: ${i.to}

Accept: ${i.acceptUrl}

This invitation expires in 7 days. If you were not expecting it, ignore this email.`,
    html: layout({
      preheader: `${i.inviterName} invited you to ${i.workspaceName} as ${role}`,
      content: `
${heading(`You are invited to ${i.workspaceName}`)}
${paragraph(`<strong>${esc(i.inviterName)}</strong> invited you to collaborate in <strong>${esc(i.workspaceName)}</strong> on Beginso.`)}
${detailCard([
  { label: "Workspace", value: i.workspaceName },
  { label: "Your role", value: role, badge: true },
  { label: "Invited email", value: i.to },
])}
${button("Accept invitation", i.acceptUrl)}
${linkFallback(i.acceptUrl)}`,
      footerNote: "This invitation expires in 7 days. If you were not expecting it, ignore this email.",
    }),
  };
}

export function renderEmailVerifiedEmail(i: { to: string; dashboardUrl: string }): RenderedMail {
  return {
    subject: "Your Beginso email is verified",
    text: `Email verified

${i.to} is confirmed. Your account is ready to use.

Open Beginso: ${i.dashboardUrl}`,
    html: layout({
      preheader: "Your account is ready to use",
      accent: "success",
      content: `
${heading("Email verified")}
${paragraph(`<strong>${esc(i.to)}</strong> is confirmed. Your account is active and ready to use.`)}
${button("Open Beginso", i.dashboardUrl, "success")}`,
      footerNote: "Thanks for verifying your email.",
    }),
  };
}

export function renderPasswordChangedEmail(i: { loginUrl: string; changedAt: Date; to: string }): RenderedMail {
  const when = formatDate(i.changedAt);
  return {
    subject: "Your Beginso password was changed",
    text: `Your password was changed

Your Beginso password was changed on ${when}.

If this was you, nothing more to do.

If it was not you, reset your password now: ${i.loginUrl}`,
    html: layout({
      preheader: `Changed on ${when} — if this was not you, act now`,
      accent: "danger",
      content: `
${heading("Your password was changed")}
${paragraph(`Your Beginso password was changed on <strong>${esc(when)}</strong>.`)}
${notice("<strong>If this was not you</strong>, someone may have access to your account. Reset your password straight away.", "danger")}
${button("Secure my account", i.loginUrl, "danger")}`,
      footerNote: `This security notice was sent to ${esc(i.to)}.`,
    }),
  };
}
