// Sprint 14 (R1, B4.1). The email a workspace member gets when there is new activity for them. Like the
// respondent email it carries NOTHING from the response: no answers, no attachments, not even the question
// text - only the form name, the response reference, when it happened and a login-gated link. It is a pure
// function of those inputs so a contract test can render it against distinctive data and prove none leaks.
export type ActivityEmailKind = "new_response" | "mention" | "assignment";

export interface ActivityEmailInput {
  kind: ActivityEmailKind;
  formName: string;
  reference?: string | null; // "#142"
  occurredAt: Date;
  actionUrl: string; // login-gated
  unsubscribeUrl: string;
}

const escapeHtml = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const HEADLINES: Record<ActivityEmailKind, (form: string, ref: string) => string> = {
  new_response: (form, ref) => `New response${ref} on ${form}`,
  mention: (form, ref) => `You were mentioned${ref ? ` on response${ref}` : ""} on ${form}`,
  assignment: (form, ref) => `A response${ref} on ${form} was assigned to you`,
};

export const renderActivityEmail = (input: ActivityEmailInput): { subject: string; text: string; html: string } => {
  const form = input.formName.trim() || "a form";
  const ref = input.reference ? ` ${input.reference}` : "";
  const when = input.occurredAt.toUTCString();
  const headline = HEADLINES[input.kind](form, ref);
  const subject = headline;

  const text = [
    headline,
    "",
    `When: ${when}`,
    "",
    "Sign in to Beginso to view it:",
    input.actionUrl,
    "",
    "For privacy this email does not include what was submitted.",
    "",
    `Do not want these emails? Unsubscribe: ${input.unsubscribeUrl}`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#F3F4F6;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#F3F4F6;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:540px;background-color:#ffffff;border-radius:16px;border:1px solid #E5E7EB;">
        <tr><td style="padding:36px;">
          <h1 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 12px 0;">${escapeHtml(headline)}</h1>
          <p style="font-size:14px;color:#4B5563;line-height:1.6;margin:0 0 24px 0;">${escapeHtml(when)}</p>
          <p style="margin:0 0 24px 0;"><a href="${escapeHtml(input.actionUrl)}" style="display:inline-block;background-color:#1D4ED8;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:8px;">Open in Beginso</a></p>
          <p style="font-size:13px;color:#6B7280;line-height:1.5;margin:0 0 8px 0;">For privacy this email does not include what was submitted. Sign in to see it.</p>
          <p style="font-size:12px;color:#9CA3AF;line-height:1.5;margin:0;"><a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#9CA3AF;">Unsubscribe from these emails</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
};
