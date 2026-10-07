/**
 * src/mail/layout.ts
 *
 * One shared layout for every Beginso email, plus the small building blocks the
 * templates compose. Pure functions only — no transport, no I/O — so every
 * template stays unit-testable the way respondentMail.ts already is.
 *
 * Why this exists: the header bar, logo, footer and copyright were duplicated in
 * six inline templates, so a footer change meant six edits.
 *
 * Email constraints honoured here:
 *  - PNG logo. SVG does not render in Gmail, Outlook, Apple Mail or Yahoo.
 *  - Tables and inline styles only. No flexbox, no grid, no <style> blocks.
 *  - Flat colour declared before any gradient, for Outlook.
 *  - Every interpolated value is HTML-escaped (see esc). The previous inline
 *    templates escaped nothing, so a workspace named `Smith & Co` or a form
 *    named `<draft>` emitted broken markup.
 *  - Hidden preheader so the inbox preview line is deliberate rather than
 *    whatever body copy happened to come first.
 */

// ---------------------------------------------------------------------------
// Brand tokens — these are the real beginso-ui.css values, not Tailwind's
// ---------------------------------------------------------------------------

export const C = {
  ink: "#041347",
  inkSoft: "#36426C",
  body: "#4E576B",
  muted: "#6E788F",
  faint: "#98A1B5",
  line: "#DDE1EA",
  lineSoft: "#EDEFF4",
  page: "#F7F8FB",
  surface: "#FFFFFF",
  surfaceSub: "#F9FAFB",
  primary: "#4274D9",
  primaryDeep: "#355DAE",
  primarySoft: "#ECF1FB",
  sky: "#7AB2D3",
  success: "#1A8F5F",
  successSoft: "#E8F5EF",
  warning: "#C77A0A",
  warningSoft: "#FDF3E3",
  error: "#D14343",
  errorSoft: "#FCEBEB",
} as const;

/**
 * DM Sans is the brand face but Gmail strips @font-face, so email gets a
 * system stack that reads closest to it. Do not add a web font link here —
 * it will be removed by most clients and loads nothing.
 */
export const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * Served from the CDN, never attached to the mail. Email clients do not render SVG, so the file the
 * mail points at is the PNG sibling of the SVG: upload src/assets/beginso-logo.png to the CDN as
 * assets/logo-full-light.png. An EMAIL_LOGO_URL ending in .svg is mapped to .png automatically.
 */
export const LOGO_URL = (
  process.env.EMAIL_LOGO_URL || "https://storage.beginso.com/assets/logo-full-light.png"
).replace(/\.svg(\?.*)?$/i, ".png$1");

export const APP_URL = process.env.APP_URL || "https://www.beginso.com";

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Escape a value for interpolation into HTML. Use on EVERY dynamic value. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape a URL for an href. Rejects anything that is not http(s) so a stored
 * value can never become `javascript:` in a mail client that still honours it.
 */
export function escUrl(url: unknown): string {
  const s = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(s)) return APP_URL;
  return esc(s);
}

// ---------------------------------------------------------------------------
// Date formatting — always explicit about zone, never the server's local time
// ---------------------------------------------------------------------------

export function formatDate(d: Date, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(d);
}

export function formatDay(d: Date, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(d);
}

/** "in 3 days", "in 7 hours", "in 10 minutes" — for expiry copy. */
export function relativeUntil(target: Date, now = new Date()): string {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return "shortly";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export type AccentTone = "brand" | "success" | "warning" | "danger" | "neutral";

const ACCENT: Record<AccentTone, { flat: string; gradient: string }> = {
  brand: { flat: C.ink, gradient: `linear-gradient(90deg, ${C.ink} 0%, ${C.primary} 100%)` },
  success: { flat: C.success, gradient: `linear-gradient(90deg, ${C.success} 0%, #3FBE8A 100%)` },
  warning: { flat: C.warning, gradient: `linear-gradient(90deg, ${C.warning} 0%, #E0A34A 100%)` },
  danger: { flat: C.error, gradient: `linear-gradient(90deg, ${C.error} 0%, ${C.warning} 100%)` },
  neutral: { flat: C.inkSoft, gradient: `linear-gradient(90deg, ${C.inkSoft} 0%, ${C.muted} 100%)` },
};

/** Primary call to action. `tone` should match the layout's accent. */
export function button(label: string, url: string, tone: AccentTone = "brand"): string {
  const bg = tone === "brand" ? C.primary : ACCENT[tone].flat;
  return `
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 24px 0;">
  <tr><td align="center">
    <a href="${escUrl(url)}" target="_blank" rel="noopener" style="background-color: ${bg}; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px; line-height: 1; display: inline-block; font-family: ${FONT};">${esc(label)}</a>
  </td></tr>
</table>`;
}

/** The "button not working?" fallback. Include it wherever there is a CTA. */
export function linkFallback(url: string): string {
  return `
<div style="background-color: ${C.surfaceSub}; border: 1px solid ${C.lineSoft}; border-radius: 10px; padding: 14px 16px; margin: 0 0 24px 0;">
  <p style="font-size: 12px; color: ${C.muted}; margin: 0 0 6px 0; font-weight: 600; font-family: ${FONT};">Button not working? Copy this link into your browser:</p>
  <a href="${escUrl(url)}" target="_blank" rel="noopener" style="font-size: 12px; color: ${C.primaryDeep}; word-break: break-all; text-decoration: underline; font-family: ${FONT};">${esc(url)}</a>
</div>`;
}

/** A tinted notice. Use sparingly — one per email at most. */
export function notice(body: string, tone: Exclude<AccentTone, "brand"> | "info" = "info"): string {
  const map = {
    info: { bg: C.primarySoft, border: "#D9E3F7", text: C.ink },
    success: { bg: C.successSoft, border: "#BFE3D2", text: "#0F5C3D" },
    warning: { bg: C.warningSoft, border: "#F0D9B0", text: "#8A5407" },
    danger: { bg: C.errorSoft, border: "#F5C9C9", text: "#9B2C2C" },
    neutral: { bg: C.surfaceSub, border: C.lineSoft, text: C.body },
  } as const;
  const s = map[tone];
  return `
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: ${s.bg}; border: 1px solid ${s.border}; border-radius: 10px; margin: 0 0 24px 0;">
  <tr><td style="padding: 14px 16px; font-size: 13px; color: ${s.text}; line-height: 1.6; font-family: ${FONT};">${body}</td></tr>
</table>`;
}

/** A label/value detail block — invitations, role changes, exports. */
export function detailCard(rows: Array<{ label: string; value: string; badge?: boolean }>): string {
  const cells = rows
    .map(
      (r, i) => `
      <tr><td style="padding: ${i === 0 ? "0" : "12px"} 0 0 0;">
        <span style="font-size: 12px; color: ${C.muted}; font-family: ${FONT}; text-transform: uppercase; letter-spacing: 0.6px;">${esc(r.label)}</span>
        ${
          r.badge
            ? `<div style="margin-top: 5px;"><span style="font-size: 12px; font-weight: 700; color: ${C.primaryDeep}; background-color: ${C.primarySoft}; padding: 4px 10px; border-radius: 20px; display: inline-block; font-family: ${FONT};">${esc(r.value)}</span></div>`
            : `<strong style="font-size: 15px; color: ${C.ink}; display: block; margin-top: 3px; font-family: ${FONT};">${esc(r.value)}</strong>`
        }
      </td></tr>`
    )
    .join("");

  return `
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 0 0 24px 0;">
  <tr><td style="background-color: ${C.surfaceSub}; border: 1px solid ${C.lineSoft}; border-radius: 12px; padding: 18px 20px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${cells}</table>
  </td></tr>
</table>`;
}

export function heading(text: string): string {
  return `<h1 style="font-size: 23px; font-weight: 700; color: ${C.ink}; margin: 0 0 12px 0; letter-spacing: -0.3px; line-height: 1.3; font-family: ${FONT};">${esc(text)}</h1>`;
}

export function paragraph(html: string, marginBottom = 20): string {
  return `<p style="font-size: 15px; color: ${C.body}; line-height: 1.6; margin: 0 0 ${marginBottom}px 0; font-family: ${FONT};">${html}</p>`;
}

export function divider(): string {
  return `<hr style="border: none; border-top: 1px solid ${C.line}; margin: 26px 0 18px 0;" />`;
}

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  /** Inbox preview line. Always set it — otherwise the client picks one for you. */
  preheader: string;
  /** Body HTML, built from the helpers above. */
  content: string;
  /** Accent colour of the 8px top bar. */
  accent?: AccentTone;
  /** Small print above the copyright. */
  footerNote?: string;
  /**
   * Notification and bulk mail only. Renders a visible unsubscribe link, which
   * Gmail expects to find in the body as well as in List-Unsubscribe.
   * Never pass this for transactional mail — an unsubscribe link on a password
   * reset is a support ticket waiting to happen.
   */
  unsubscribeUrl?: string;
}

export function layout(opts: LayoutOptions): string {
  const { preheader, content, accent = "brand", footerNote, unsubscribeUrl } = opts;
  const a = ACCENT[accent];

  // Stops Gmail pulling body copy in after the preheader.
  const spacer = "&#8199;&#65279;&nbsp;".repeat(30);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
</head>
<body style="margin: 0; padding: 0; background-color: ${C.page}; font-family: ${FONT}; -webkit-font-smoothing: antialiased;">
<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">${esc(preheader)}</div>
<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">${spacer}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: ${C.page};">
  <tr><td align="center" style="padding: 40px 16px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: ${C.surface}; border-radius: 16px; overflow: hidden; border: 1px solid ${C.line};">
      <tr><td style="background: ${a.flat}; background: ${a.gradient}; height: 8px; line-height: 8px; font-size: 0;">&nbsp;</td></tr>
      <tr><td style="padding: 36px 32px 32px 32px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 26px;">
          <tr><td>
            <img src="${escUrl(LOGO_URL)}" alt="Beginso" width="168" height="46" style="display: block; width: 168px; max-width: 100%; border: 0; outline: none; text-decoration: none;" />
          </td></tr>
        </table>
        ${content}
        ${divider()}
        <p style="font-size: 12px; color: ${C.faint}; margin: 0; line-height: 1.6; text-align: center; font-family: ${FONT};">
          ${footerNote ? `${footerNote}<br/>` : ""}
          ${
            unsubscribeUrl
              ? `<a href="${escUrl(unsubscribeUrl)}" style="color: ${C.muted}; text-decoration: underline;">Unsubscribe from these emails</a> &middot; <a href="${escUrl(`${APP_URL}/settings?tab=notifications`)}" style="color: ${C.muted}; text-decoration: underline;">Notification settings</a><br/>`
              : ""
          }
          &copy; ${new Date().getFullYear()} Beginso Inc. All rights reserved.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Every template returns this. */
export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}
