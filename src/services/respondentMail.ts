import { APP_URL, layout, heading, paragraph, button, linkFallback, notice, codeBlock, esc, formatDay, C, FONT } from "../mail/layout";

// Sprint 13, BE 0.11 (A5.5 - a sprint gate item). The emails a respondent receives. They carry NOTHING from the response: no answers, no
// attachments, not even the questions. That is what makes a mistyped address harmless - the worst a stranger learns is that someone
// submitted to a form with this name. Both are pure functions (of the form name, a link or a code, an expiry) precisely so a contract
// test can render them against a response full of distinctive answers and prove none of them can appear.
//
// Both use the same layout as every other Beginso email (logo, accent bar, footer, dark mode, preheader).
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

/** After a submission to a form that asks for a verified address: the signed link to view or correct it, and the offer to keep every submission in one account. */
export const renderRespondentLinkEmail = ({ formName, actionUrl, expiresAt, accountUrl = `${APP_URL}/my-submissions` }: RespondentLinkEmailInput): RenderedEmail => {
  const name = formName.trim() || "a form";
  const expires = formatDay(expiresAt);
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

  const html = layout({
    preheader: `Your response to ${name} was received. View or correct it any time until ${expires}.`,
    content: `
${heading("Thanks for your submission")}
${paragraph(`You submitted a response to <strong>${esc(name)}</strong>. Use the button below to view it or correct it.`)}
${button("View or correct my submission", actionUrl)}
${linkFallback(actionUrl)}
${notice(`This link expires on <strong>${esc(expires)}</strong>. For your privacy this email does not repeat what you submitted.`)}
<h2 style="font-size: 17px; font-weight: 700; color: ${C.ink}; margin: 8px 0 8px 0; line-height: 1.3; font-family: ${FONT};">Keep all your submissions in one place</h2>
${paragraph("Optional. Sign in or create an account with this address to see everything you have submitted. We never create one for you.", 16)}
${button("Link my submissions to my account", accountUrl, "neutral")}`,
    footerNote: "If you did not make this submission, you can ignore this email.",
  });

  return { subject, text, html };
};

export interface EmailCodeInput {
  formName: string;
  code: string;
  expiresAt: Date;
}

/**
 * "Anyone, with a verified email": the 6-digit code, BEFORE the form starts. The code leads everywhere an inbox looks first: the subject
 * ("482913 is your code for ..."), the hidden preview line (the preheader, which Gmail shows next to the subject) and the first line of the
 * plain-text part. That is what lets a phone show it in the notification and offer to paste it.
 */
export const renderEmailCodeEmail = ({ formName, code, expiresAt }: EmailCodeInput): RenderedEmail => {
  const name = formName.trim() || "a form";
  const subject = `${code} is your code for ${name}`;
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60000));

  const text = [
    `${code} is your code to respond to "${name}".`,
    "",
    `Type it into the form to continue. It works for about ${minutes} minutes.`,
    "",
    "Do not share this code with anyone.",
    "If you did not ask for it, you can ignore this email.",
  ].join("\n");

  const html = layout({
    preheader: `Your code is ${code}. It works for about ${minutes} minutes.`,
    content: `
${heading("Your code")}
${paragraph(`Type this code into the form to respond to <strong>${esc(name)}</strong>.`, 18)}
${codeBlock(code)}
${notice(`It works for about <strong>${minutes} minutes</strong>. Do not share it with anyone.`)}`,
    footerNote: "If you did not ask for this code, you can ignore this email.",
  });

  return { subject, text, html };
};
