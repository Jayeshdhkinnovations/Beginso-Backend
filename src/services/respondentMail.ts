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

export const renderRespondentLinkEmail = ({ formName, actionUrl, expiresAt }: RespondentLinkEmailInput): RenderedEmail => {
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
    "For your privacy this email does not repeat what you submitted.",
    "If you did not make this submission, you can ignore this email.",
  ].join("\n");

  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(actionUrl);
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
          <p style="font-size:13px;color:#6B7280;line-height:1.5;margin:0 0 8px 0;">This link expires on ${escapeHtml(expires)}.</p>
          <p style="font-size:13px;color:#6B7280;line-height:1.5;margin:0;">For your privacy this email does not repeat what you submitted. If you did not make this submission, you can ignore this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
};
