import crypto from "crypto";
import jwt from "jsonwebtoken";
import Form from "../models/Form";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import ResponseModel from "../models/Response";
import User from "../models/User";
import { MailLog, computeEmailHash } from "../models/MailLog";
import { mailService } from "./mail.service";
import { ActivityEmailKind } from "./notificationMail";

// Sprint 14 (R1, B4.1/B4.2, OQ-2). Email for the three things a member asked to hear about: a new response,
// a mention, an assignment.
//
// Preference is the member's own Membership.notificationPreference:
//   all  -> every new response, plus mentions and assignments
//   mine -> responses assigned to them or on forms they created, plus mentions and assignments (those are
//           addressed to them by definition)
//   none -> nothing
// A test submission never emails. The workspace-wide "new response email" switch (Workspace settings) still
// acts as a master off for the new-response kind.
//
// Delivery is non-blocking (queueActivityEmails), idempotent (one MailLog row per event + recipient, enforced
// by a unique `dedupeKey`), and logged. The body has no answers, attachments or questions (notificationMail.ts).

export interface ActivityEmailEvent {
  kind: ActivityEmailKind;
  formId: unknown;
  responseId?: unknown;
  // Identifies THIS occurrence so a retry cannot send twice: the response id for a new response, the
  // in-app notification id for a mention / assignment.
  eventKey: string;
  // mention / assignment: the one person it is for.
  recipientUserId?: unknown;
}

const UNSUBSCRIBE_AUDIENCE = "beginso:unsubscribe";
const UNSUBSCRIBE_TTL = "30d";

export const signUnsubscribeToken = (membershipId: string): string =>
  jwt.sign({ mid: membershipId }, process.env.JWT_SECRET as string, {
    audience: UNSUBSCRIBE_AUDIENCE,
    expiresIn: UNSUBSCRIBE_TTL,
  });

export type UnsubscribeResult = { ok: true; membershipId: string } | { ok: false; reason: "expired" | "invalid" };

export const verifyUnsubscribeToken = (token: string): UnsubscribeResult => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string, { audience: UNSUBSCRIBE_AUDIENCE }) as { mid?: string };
    return decoded?.mid ? { ok: true, membershipId: decoded.mid } : { ok: false, reason: "invalid" };
  } catch (err: any) {
    return { ok: false, reason: err?.name === "TokenExpiredError" ? "expired" : "invalid" };
  }
};

const appUrl = (): string => process.env.APP_URL || "https://beginso.com";
// Where the unsubscribe link points. The backend is normally reached through the app's same-origin proxy
// (`<APP_URL>/api/backend`); set API_PUBLIC_URL (no trailing slash, no "/api") if it has its own public host.
const apiUrl = (): string => (process.env.API_PUBLIC_URL || `${appUrl()}/api/backend`).replace(/\/+$/, "");

const claim = async (dedupeKey: string, kind: ActivityEmailKind, email: string): Promise<any | null> => {
  try {
    return await MailLog.create({
      template: kind,
      outcome: "queued",
      emailHash: computeEmailHash(email),
      requestId: `req_${crypto.randomBytes(8).toString("hex")}`,
      provider: "smtp",
      dedupeKey,
    });
  } catch (err: any) {
    if (err?.code === 11000) return null; // already handled: idempotent
    throw err;
  }
};

// Awaitable version (tests, scripts). Returns how many emails were handed to the mail provider.
export const sendActivityEmails = async (event: ActivityEmailEvent): Promise<number> => {
  const form: any = await Form.findById(event.formId).select("title workspaceId createdBy").lean();
  if (!form?.workspaceId) return 0; // a personal form has no members to notify
  const workspace: any = await Workspace.findById(form.workspaceId).select("slug status notificationPreferences").lean();
  if (!workspace || workspace.status === "deleted" || workspace.status === "suspended") return 0;

  // `_id` in the filter bypasses the isTest hook; the test check is explicit.
  const response: any = event.responseId ? await ResponseModel.findById(event.responseId).select("isTest reference assigneeId").lean() : null;
  if (response?.isTest) return 0;
  if (event.kind === "new_response" && !response) return 0;

  let userIds: string[] = [];
  if (event.kind === "new_response") {
    if (workspace.notificationPreferences?.newResponseEmail === false) return 0;
    const members: any[] = await Membership.find({ workspaceId: form.workspaceId, notificationPreference: { $in: ["all", "mine"] } })
      .select("userId notificationPreference")
      .lean();
    userIds = members
      .filter(
        (m) =>
          m.notificationPreference === "all" ||
          String(m.userId) === String(form.createdBy) ||
          (response?.assigneeId && String(m.userId) === String(response.assigneeId))
      )
      .map((m) => String(m.userId));
  } else if (event.recipientUserId) {
    const m: any = await Membership.findOne({ workspaceId: form.workspaceId, userId: event.recipientUserId as any })
      .select("userId notificationPreference")
      .lean();
    if (m && m.notificationPreference !== "none") userIds = [String(m.userId)];
  }
  if (userIds.length === 0) return 0;

  const users: any[] = await User.find({ _id: { $in: userIds }, status: { $ne: "suspended" } }).select("email").lean();
  const memberships: any[] = await Membership.find({ workspaceId: form.workspaceId, userId: { $in: userIds } }).select("_id userId").lean();
  const membershipByUser = new Map(memberships.map((m) => [String(m.userId), String(m._id)]));

  let sent = 0;
  for (const user of users) {
    if (!user.email) continue;
    const log = await claim(`${event.kind}:${event.eventKey}:${user._id}`, event.kind, user.email);
    if (!log) continue;
    const membershipId = membershipByUser.get(String(user._id));
    const ok =
      (await mailService.sendMail({
        to: user.email,
        template: "activity_notification",
        activity: {
          kind: event.kind,
          formName: form.title,
          reference: response?.reference ?? null,
          occurredAt: new Date(),
          actionUrl: `${appUrl()}/login?next=${encodeURIComponent(`/w/${workspace.slug}/inbox`)}`,
          unsubscribeUrl: `${apiUrl()}/api/public/notifications/unsubscribe/${signUnsubscribeToken(membershipId ?? "")}`,
        },
      })) !== false;
    await MailLog.updateOne({ _id: log._id }, { $set: { outcome: ok ? "sent" : "failed" } }).catch(() => undefined);
    if (ok) sent++;
  }
  return sent;
};

// Fire-and-forget: never throws, never delays the request that caused it.
export const queueActivityEmails = (event: ActivityEmailEvent): void => {
  setImmediate(() => {
    sendActivityEmails(event).catch((err) => console.error("Activity email failed:", err?.message || err));
  });
};
