import { APP_URL } from "../mail/layout";
// Sprint 13, BE 0.11 (A5.5 - a sprint gate item). The email a respondent receives after a tracked
// submission. It carries NOTHING from the response: no answers, no attachments, not even the questions.
// That is what makes a mistyped address harmless - the worst a stranger learns is that someone
// submitted to a form with this name. It is a pure function of (form name, link, expiry) precisely so
// a contract test can render it against a response full of distinctive answers and prove none of them
// can appear.
export interface RespondentLinkEmailInput {
  formName: string;
  actionUrl: string;
  expiresAt: Date;
  /** Where "Link my submissions to my account" goes: the signed-in My submissions page (no token, no answers). */
  accountUrl?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatDate = (d: Date): string =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export const renderRespondentLinkEmail = ({ formName, actionUrl, expiresAt, accountUrl = `${APP_URL}/my-submissions` }: RespondentLinkEmailInput): RenderedEmail => {
  const name = formName.trim() || "a form";
  const expires = formatDate(expiresAt);
  const subject = `Your submission to ${name}`;

  const text = [
    "Thanks for your submission.",
    "",
    `You submitted a response to "${name}". Use the link below to view it or correct it.`,
    "",
    actionUrl,
    "",
    `This link expires on ${expires}.`,
    "",
    "Keep all your submissions in one place",
    "Optional. Sign in or create an account with this address to see everything you have submitted. We never create one for you.",
    "Link my submissions to my account:",
    accountUrl,
    "",
    "For your privacy this email does not repeat what you submitted.",
    "If you did not make this submission, you can ignore this email.",
  ].join("\n");

  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(actionUrl);
  const safeAccountUrl = escapeHtml(accountUrl);
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#F3F4F6;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#F3F4F6;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:540px;background-color:#ffffff;border-radius:16px;border:1px solid #E5E7EB;">
        <tr><td style="padding:36px;">
          <h1 style="font-size:22px;font-weight:700;color:#111827;margin:0 0 12px 0;">Thanks for your submission</h1>
          <p style="font-size:15px;color:#4B5563;line-height:1.6;margin:0 0 24px 0;">You submitted a response to <strong>${safeName}</strong>. Use the button below to view it or correct it.</p>
          <p style="margin:0 0 24px 0;"><a href="${safeUrl}" style="display:inline-block;background-color:#1D4ED8;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:8px;">View or correct my submission</a></p>
          <p style="font-size:13px;color:#6B7280;line-height:1.5;margin:0 0 24px 0;">This link expires on ${escapeHtml(expires)}.</p>
          <hr style="border:none;border-top:1px solid #E5E7EB;margin:0 0 24px 0;">
          <h2 style="font-size:17px;font-weight:700;color:#111827;margin:0 0 8px 0;">Keep all your submissions in one place</h2>
          <p style="font-size:14px;color:#4B5563;line-height:1.6;margin:0 0 16px 0;">Optional. Sign in or create an account with this address to see everything you have submitted. We never create one for you.</p>
          <p style="margin:0 0 24px 0;"><a href="${safeAccountUrl}" style="display:inline-block;background-color:#ffffff;color:#1D4ED8;border:1px solid #1D4ED8;text-decoration:none;font-weight:600;font-size:15px;padding:11px 24px;border-radius:8px;">Link my submissions to my account</a></p>
          <p style="font-size:13px;color:#6B7280;line-height:1.5;margin:0;">For your privacy this email does not repeat what you submitted. If you did not make this submission, you can ignore this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
};

// "Anyone, with a verified email" forms: the mail that carries the 6-digit code, BEFORE the form starts. Like the link mail it carries
// nothing but the form's name and the code.
export interface EmailCodeInput {
  formName: string;
  code: string;
  expiresAt: Date;
}

export const renderEmailCodeEmail = ({ formName, code, expiresAt }: EmailCodeInput): RenderedEmail => {
  const name = formName.trim() || "a form";
  const subject = `${code} is your code for ${name}`;
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60000));
  const text = [
    `Your code to respond to "${name}":`,
    "",
    code,
    "",
    `It works for about ${minutes} minutes. Type it into the form to continue.`,
    "",
    "If you did not ask for this, you can ignore this email.",
  ].join("\n");
  const safeName = escapeHtml(name);
  const safeCode = escapeHtml(code);
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#F3F4F6;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#F3F4F6;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:540px;background-color:#ffffff;border-radius:16px;border:1px solid #E5E7EB;">
        <tr><td style="padding:36px;">
          <h1 style="font-size:22px;font-weight:700;color:#111827;margin:0 0 12px 0;">Your code</h1>
          <p style="font-size:15px;color:#4B5563;line-height:1.6;margin:0 0 24px 0;">Type this code into the form to respond to <strong>${safeName}</strong>.</p>
          <p style="font-size:34px;font-weight:700;letter-spacing:8px;color:#111827;margin:0 0 24px 0;">${safeCode}</p>
          <p style="font-size:13px;color:#6B7280;line-height:1.5;margin:0 0 8px 0;">It works for about ${minutes} minutes.</p>
          <p style="font-size:13px;color:#6B7280;line-height:1.5;margin:0;">If you did not ask for this, you can ignore this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
};
