// Redaction of container log text before it leaves the server (super admin Server page). Pure functions, no I/O. Every string is run through
// redactLine() BEFORE it is searched, filtered or sent, so a secret that a service printed by mistake is never shown in the console.
//
// Properties: never throws (odd input gives a harmless string), idempotent (redacting an already redacted string changes nothing), and
// bounded (a line longer than 4000 characters is cut with a marker BEFORE any regex runs, so a hostile huge line cannot burn CPU).
// Email addresses are masked last: a***@domain.com.

export const MAX_LINE_CHARS = 4000;
export const TRUNCATION_MARK = "…[truncated]";

// scheme://user:pass@host  ->  scheme://[REDACTED]@host
const URI_CREDENTIALS = /\b([a-z][a-z0-9+.-]{1,20}):\/\/[^\s/:@]*:[^\s/@]*@/gi;
// Cookie: ... / Set-Cookie: ... (the whole rest of the line)
const COOKIE_LINE = /\b(Set-Cookie|Cookie)(?!\s*:\s*\[REDACTED\]\s*$)(\s*:\s*)[^\r\n]*/gi;
const SESSION_COOKIE = /\b(beginso_session\s*=\s*)(?!\[REDACTED\])[^\s;,"']+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// Authorization / Proxy-Authorization values, in header or JSON form, with or without a scheme word. The lookahead leaves an already
// redacted value alone (idempotence).
const AUTH_HEADER =
  /\b((?:Proxy-)?Authorization["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Digest|Token)\s+\[REDACTED\]|\[REDACTED\])(?:(Bearer|Basic|Digest|Token)\s+)?[^\s"',;]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const GOOGLE_TOKENS = [/\bAIza[0-9A-Za-z_-]{35}\b/g, /\bya29\.[0-9A-Za-z_-]+/g, /(?<![\w/])1\/\/[0-9A-Za-z_-]{20,}/g];
// "password":"x"  password=x  password: x  (key kept, value replaced; a quoted value keeps its quotes so JSON stays valid). The key may carry
// a prefix or suffix (accessToken, user_password, x-api-key, session_id). A value that is already [REDACTED] is left alone (idempotence).
const SECRET_PAIR =
  /(\b[\w-]*(?:password|passwd|pwd|token|secret|api[_-]?key|cookie|session|credential|private[_-]?key)[\w-]*["']?\s*[:=]\s*)(?!["']?\[REDACTED\])("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;&"'}\]]+)/gi;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

/** Redacts one line (or any short text). Never throws. */
export function redactLine(input: unknown): string {
  try {
    let s = typeof input === "string" ? input : input == null ? "" : String(input);
    if (s.length > MAX_LINE_CHARS && !(s.endsWith(TRUNCATION_MARK) && s.length <= 2 * MAX_LINE_CHARS)) {
      s = s.slice(0, MAX_LINE_CHARS) + TRUNCATION_MARK;
    }
    s = s.replace(URI_CREDENTIALS, "$1://[REDACTED]@");
    s = s.replace(COOKIE_LINE, "$1$2[REDACTED]");
    s = s.replace(SESSION_COOKIE, "$1[REDACTED]");
    s = s.replace(BEARER, "Bearer [REDACTED]");
    s = s.replace(AUTH_HEADER, (_m, prefix: string, scheme?: string) => `${prefix}${scheme ? `${scheme} ` : ""}[REDACTED]`);
    s = s.replace(JWT, "[REDACTED_JWT]");
    for (const re of GOOGLE_TOKENS) s = s.replace(re, "[REDACTED_TOKEN]");
    s = s.replace(SECRET_PAIR, (_m, prefix: string, value: string) => {
      const q = value[0];
      return q === '"' || q === "'" ? `${prefix}${q}[REDACTED]${q}` : `${prefix}[REDACTED]`;
    });
    s = s.replace(EMAIL, "$1***@$2"); // last, so the rules above see the original addresses
    return s;
  } catch {
    return "[unreadable]";
  }
}

/** Redacts a multi-line text (a stack trace) line by line, so the per-line length cap applies to each line. */
export function redactBlock(input: unknown): string {
  try {
    const s = typeof input === "string" ? input : input == null ? "" : String(input);
    return s.split("\n").map(redactLine).join("\n");
  } catch {
    return "[unreadable]";
  }
}
