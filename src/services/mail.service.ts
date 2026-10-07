import nodemailer from "nodemailer";
import crypto from "crypto";
import { recordMailLog, MailLogTemplate } from "../models/MailLog";
import { renderRespondentLinkEmail } from "./respondentMail";
import { renderActivityEmail, ActivityEmailInput } from "./notificationMail";
import { RenderedMail, APP_URL } from "../mail/layout";
import * as T from "../mail/templates";

export type AuthMailType =
  | "verify_email"
  | "verify_email_otp"
  | "reset_password"
  | "welcome_user"
  | "email_verified_success"
  | "password_changed_success"
  | "workspace_invitation"
  | "respondent_submission_link"
  | "activity_notification"
  | "role_changed"
  | "member_removed"
  | "invitation_accepted"
  | "invitation_reminder"
  | "form_shared"
  | "export_ready"
  | "export_failed"
  | "response_limit_reached"
  | "new_device_signin"
  | "respondent_receipt"
  | "weekly_digest"
  | "workspace_deleted";

// One typed payload per data-carrying template, instead of widening SendMailOptions with more optionals.
export type MailPayload =
  | { template: "role_changed"; data: T.RoleChangedInput }
  | { template: "member_removed"; data: T.MemberRemovedInput }
  | { template: "invitation_accepted"; data: T.InvitationAcceptedInput }
  | { template: "invitation_reminder"; data: T.InvitationReminderInput }
  | { template: "form_shared"; data: T.FormSharedInput }
  | { template: "export_ready"; data: T.ExportReadyInput }
  | { template: "export_failed"; data: T.ExportFailedInput }
  | { template: "response_limit_reached"; data: T.ResponseLimitInput }
  | { template: "new_device_signin"; data: T.NewDeviceSigninInput }
  | { template: "respondent_receipt"; data: T.RespondentReceiptInput }
  | { template: "weekly_digest"; data: T.WeeklyDigestInput }
  | { template: "workspace_deleted"; data: T.WorkspaceDeletedInput };

export interface SendMailOptions {
  to: string;
  template: AuthMailType;
  /** Required for the twelve templates in MailPayload; pass that template's data. */
  payload?: MailPayload["data"];
  actionUrl?: string;
  code?: string;
  name?: string;
  firebaseUid?: string;
  requestId?: string;
  workspaceName?: string;
  inviterName?: string;
  role?: string;
  formName?: string;
  expiresAt?: Date;
  activity?: ActivityEmailInput;
}

// Notification and bulk mail carry List-Unsubscribe. Transactional mail must not.
const BULK: ReadonlySet<AuthMailType> = new Set<AuthMailType>([
  "activity_notification",
  "weekly_digest",
  "invitation_accepted",
  "form_shared",
  "response_limit_reached",
]);

const PAYLOAD_RENDERERS: Partial<Record<AuthMailType, (d: any) => RenderedMail>> = {
  role_changed: T.renderRoleChangedEmail,
  member_removed: T.renderMemberRemovedEmail,
  invitation_accepted: T.renderInvitationAcceptedEmail,
  invitation_reminder: T.renderInvitationReminderEmail,
  form_shared: T.renderFormSharedEmail,
  export_ready: T.renderExportReadyEmail,
  export_failed: T.renderExportFailedEmail,
  response_limit_reached: T.renderResponseLimitEmail,
  new_device_signin: T.renderNewDeviceSigninEmail,
  respondent_receipt: T.renderRespondentReceiptEmail,
  weekly_digest: T.renderWeeklyDigestEmail,
  workspace_deleted: T.renderWorkspaceDeletedEmail,
};

const maskEmail = (e: string): string => e.replace(/^(.).*(@.*)$/, "$1***$2");

// Renders without sending. Null for an unknown template or a missing payload, so the caller
// refuses to send instead of emitting a blank message.
export function renderMail(o: SendMailOptions): RenderedMail | null {
  const { to, template, actionUrl, name } = o;
  switch (template) {
    case "verify_email":
    case "verify_email_otp":
      return T.renderVerifyEmail({ revealUrl: actionUrl || `${APP_URL}/verification-code` });
    case "reset_password":
      return T.renderResetPasswordEmail({ resetUrl: actionUrl || `${APP_URL}/reset-password` });
    case "welcome_user":
      return T.renderWelcomeEmail({ name, dashboardUrl: actionUrl || `${APP_URL}/dashboard` });
    case "workspace_invitation":
      return T.renderWorkspaceInvitationEmail({
        to,
        workspaceName: o.workspaceName || "our workspace",
        inviterName: o.inviterName || "A team member",
        role: o.role || "member",
        acceptUrl: actionUrl || `${APP_URL}/dashboard`,
      });
    case "email_verified_success":
      return T.renderEmailVerifiedEmail({ to, dashboardUrl: actionUrl || `${APP_URL}/dashboard` });
    case "password_changed_success":
      return T.renderPasswordChangedEmail({ to, loginUrl: actionUrl || `${APP_URL}/login`, changedAt: new Date() });
    case "activity_notification":
      return o.activity ? renderActivityEmail(o.activity) : null;
    case "respondent_submission_link":
      // Pure function so the "no answers in the email" rule is provable (respondentMail.ts).
      return renderRespondentLinkEmail({
        formName: o.formName || "",
        actionUrl: actionUrl || APP_URL,
        expiresAt: o.expiresAt || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      });
    default: {
      const render = PAYLOAD_RENDERERS[template];
      return render && o.payload ? render(o.payload) : null;
    }
  }
}

class MailService {
  private transporter: nodemailer.Transporter | null = null;

  private getTransporter(): nodemailer.Transporter {
    if (!this.transporter) {
      const host = process.env.SMTP_HOST || "email.toowix.com";
      const port = Number(process.env.SMTP_PORT) || 587;
      const secure = process.env.SMTP_SECURE === "true";
      const user = process.env.SMTP_USER || "";
      const pass = process.env.SMTP_PASS || "";

      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        // Never fall back to plaintext on 587. SMTP_REQUIRE_TLS=false is the explicit opt-out.
        requireTLS: !secure && process.env.SMTP_REQUIRE_TLS !== "false",
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
        auth: user && pass ? { user, pass } : undefined,
        tls: {
          // Verify the server certificate. If the relay uses a self-signed cert, set
          // SMTP_TLS_REJECT_UNAUTHORIZED=false explicitly instead of disabling it for everyone.
          rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false",
        },
        // Only when the relay cannot sign as the sending domain. Relay-side signing is better.
        ...(process.env.DKIM_PRIVATE_KEY
          ? {
              dkim: {
                domainName: process.env.DKIM_DOMAIN || process.env.MAIL_DOMAIN || "mail.beginso.com",
                keySelector: process.env.DKIM_SELECTOR || "beginso",
                privateKey: process.env.DKIM_PRIVATE_KEY.replace(/\\n/g, "\n"),
              },
            }
          : {}),
      });
    }
    return this.transporter;
  }

  // Resolves true when the provider accepted the message, false when it failed (never throws).
  async sendMail(options: SendMailOptions): Promise<boolean> {
    const startTime = Date.now();
    const reqId = options.requestId || `req_${crypto.randomBytes(8).toString("hex")}`;
    const fromName = process.env.SMTP_FROM_NAME || "Beginso";
    const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "no-reply@beginso.com";
    const from = `"${fromName}" <${fromEmail}>`;
    // Set once mail.beginso.com has SPF/DKIM/DMARC. Until then the relay's own defaults apply.
    const sendingDomain = process.env.MAIL_DOMAIN;

    const { to, template, firebaseUid } = options;

    let mappedLogTemplate: MailLogTemplate | null = null;
    if (template === "verify_email" || template === "verify_email_otp") mappedLogTemplate = "verification";
    else if (template === "reset_password") mappedLogTemplate = "password_reset";
    else if (template === "welcome_user" || template === "workspace_invitation") mappedLogTemplate = "welcome";
    // activity_notification is logged by notificationEmail.service (claim) with its dedupe key.
    else if (template !== "activity_notification") mappedLogTemplate = template as MailLogTemplate;

    const rendered = renderMail(options);
    if (!rendered) {
      console.error(`❌ No renderer or payload for template ${template}; not sending to ${maskEmail(to)}`);
      return false;
    }

    const unsubscribeUrl = BULK.has(template)
      ? options.activity?.unsubscribeUrl || (options.payload as { unsubscribeUrl?: string } | undefined)?.unsubscribeUrl
      : undefined;

    try {
      const transporter = this.getTransporter();
      await transporter.sendMail({
        from,
        to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html.trim(),
        replyTo: process.env.SMTP_REPLY_TO || "support@beginso.com",
        ...(sendingDomain
          ? { envelope: { from: `bounces@${sendingDomain}`, to }, messageId: `<${crypto.randomUUID()}@${sendingDomain}>` }
          : {}),
        headers: {
          "Auto-Submitted": "auto-generated",
          "X-Entity-Ref-ID": reqId,
          ...(unsubscribeUrl
            ? {
                "List-Unsubscribe": `<${unsubscribeUrl}>${sendingDomain ? `, <mailto:unsubscribe@${sendingDomain}?subject=unsubscribe>` : ""}`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              }
            : {}),
        },
      });
      console.log(`✉️ Email sent to ${maskEmail(to)} [template: ${template}]`);

      if (mappedLogTemplate) {
        await recordMailLog({
          template: mappedLogTemplate,
          outcome: "sent",
          email: to,
          firebaseUid,
          requestId: reqId,
          provider: "smtp",
          latencyMs: Date.now() - startTime,
        });
      }
      return true;
    } catch (err: any) {
      console.error(`❌ Failed to send ${template} email to ${maskEmail(to)}:`, err.message);

      if (mappedLogTemplate) {
        await recordMailLog({
          template: mappedLogTemplate,
          outcome: "failed",
          email: to,
          firebaseUid,
          requestId: reqId,
          provider: "smtp",
          errorCode: err.code || err.name || "PROVIDER_ERROR",
          latencyMs: Date.now() - startTime,
        });
      }
    }
    return false;
  }
}

export const mailService = new MailService();
