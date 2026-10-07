import dotenv from "dotenv";
import mongoose from "mongoose";
import { mailService, SendMailOptions } from "../services/mail.service";

dotenv.config();
// No DB here: fail MailLog writes immediately instead of buffering for 10s per email.
mongoose.set("bufferCommands", false);
const origError = console.error;
console.error = (...a: unknown[]) => {
  if (!String(a[0]).startsWith("Failed to write MailLog")) origError(...a);
};

// Usage: npx ts-node src/scripts/sendTemplatePreview.ts [address]
const to = process.argv[2] || "piyush270205@gmail.com";
const app = process.env.APP_URL || "https://www.beginso.com";
const day = 24 * 60 * 60 * 1000;
const unsubscribeUrl = `${app}/api/public/notifications/unsubscribe/sample-token`;

const mails: SendMailOptions[] = [
  { to, template: "verify_email", actionUrl: `${app}/verification-code?ticket=sample` },
  { to, template: "reset_password", actionUrl: `${app}/reset-password?oobCode=sample` },
  { to, template: "welcome_user", name: "Piyush" },
  { to, template: "workspace_invitation", workspaceName: "Smith & Co", inviterName: "Asha Rao", role: "member", actionUrl: `${app}/invite/sample` },
  { to, template: "email_verified_success" },
  { to, template: "password_changed_success" },
  { to, template: "respondent_submission_link", formName: "Customer feedback", actionUrl: `${app}/f/sample`, expiresAt: new Date(Date.now() + 14 * day) },
  {
    to, template: "activity_notification",
    activity: { kind: "new_response", formName: "Customer feedback", reference: "#142", occurredAt: new Date(), actionUrl: `${app}/login`, unsubscribeUrl },
  },
  { to, template: "role_changed", payload: { workspaceName: "Smith & Co", workspaceSlug: "smith-co", oldRole: "viewer", newRole: "member", changedByName: "Asha Rao", sessionsRevoked: true } },
  { to, template: "member_removed", payload: { workspaceName: "Smith & Co", removedByName: "Asha Rao" } },
  { to, template: "invitation_accepted", payload: { memberName: "Ravi Kumar", memberEmail: "ravi@example.com", role: "member", workspaceName: "Smith & Co", workspaceSlug: "smith-co", unsubscribeUrl } },
  { to, template: "invitation_reminder", payload: { workspaceName: "Smith & Co", inviterName: "Asha Rao", role: "member", acceptUrl: `${app}/invite/sample`, expiresAt: new Date(Date.now() + 4 * day), invitedEmail: to } },
  { to, template: "form_shared", payload: { formName: "Customer feedback", formId: "sample", sharedByName: "Asha Rao", accessLevel: "reviewer", workspaceName: "Smith & Co", unsubscribeUrl } },
  { to, template: "export_ready", payload: { format: "PDF", formName: "Customer feedback", rowCount: 248, fileSizeBytes: 1_843_200, downloadUrl: `${app}/exports/sample`, expiresAt: new Date(Date.now() + day), timeZone: "Asia/Kolkata" } },
  { to, template: "export_failed", payload: { format: "PDF", formName: "Customer feedback", reason: "The file took too long to build.", retryUrl: `${app}/exports` } },
  { to, template: "response_limit_reached", payload: { formName: "Customer feedback", formId: "sample", reason: "limit", limit: 500, totalResponses: 500, closedAt: new Date(), timeZone: "Asia/Kolkata", unsubscribeUrl } },
  { to, template: "new_device_signin", payload: { device: "Chrome on Windows", approxLocation: "Pune, Maharashtra, IN", signedInAt: new Date(), timeZone: "Asia/Kolkata" } },
  {
    to, template: "respondent_receipt",
    payload: {
      formName: "Customer feedback", brandName: "Smith & Co", submittedAt: new Date(), timeZone: "Asia/Kolkata",
      answers: [{ question: "Your name", answer: "Piyush" }, { question: "How did we do?", answer: "Great,\nthank you!" }],
      editUrl: `${app}/f/sample/edit`, editExpiresAt: new Date(Date.now() + 7 * day), contactEmail: "support@smithco.example",
    },
  },
  {
    to, template: "weekly_digest",
    payload: {
      recipientName: "Piyush", periodStart: new Date(Date.now() - 7 * day), periodEnd: new Date(), timeZone: "Asia/Kolkata",
      totalResponses: 64, previousTotal: 48, unreadCount: 12,
      topForms: [{ name: "Customer feedback", formId: "a", responses: 40 }, { name: "Event signup", formId: "b", responses: 24 }],
      quietForms: [{ name: "Careers", formId: "c" }], unsubscribeUrl,
    },
  },
  { to, template: "workspace_deleted", payload: { workspaceName: "Smith & Co", deletedByName: "Asha Rao", deletedAt: new Date(), timeZone: "Asia/Kolkata", formCount: 7, responseCount: 1204, memberCount: 5 } },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`Sending ${mails.length} previews to ${to}`);
  let failed = 0;
  for (const [i, m] of mails.entries()) {
    // The relay answers 452 "rate limit exceeded" when mail goes out too fast; wait it out and retry once.
    let ok = await mailService.sendMail(m);
    if (!ok) {
      console.log(`  ${m.template} failed, waiting 90s before one retry`);
      await sleep(90_000);
      ok = await mailService.sendMail(m);
    }
    if (!ok) failed++;
    console.log(`${i + 1}/${mails.length} ${m.template}: ${ok ? "sent" : "FAILED"}`);
    await sleep(8_000);
  }
  console.log(failed ? `${failed} failed` : "All sent");
  process.exit(failed ? 1 : 0);
})();
