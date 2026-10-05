import crypto from "crypto";
import { RateLimitBucket } from "../models/RateLimitBucket";

// Sprint 13, BE 0.7 (D1.1 Mode 3, OQ-10). Mode 3 forms need a signed-in respondent, but the browser never
// holds the session token (the frontend's same-origin proxy does) and that proxy buffers whole request
// bodies, far below this API's 25 MB-per-file upload limit. So the proxy asks for a TICKET - a short-lived,
// single-use credential bound to one account and one form - and the browser then sends the multipart
// submission straight here, carrying the ticket instead of a session. The upload limits stay intact and
// no long-lived credential ever reaches the page.
//
// A ticket is `<payload>.<signature>`: the payload names {user, form, expiry, id}; the signature is an
// HMAC under the server pepper, so it cannot be forged or retargeted at another form. Single use is
// enforced with an atomic upsert (the same technique recordFormView uses), so it holds across instances.

const TICKET_LIFETIME_MS = 2 * 60 * 1000;

const secret = (): string => process.env.AUTH_EMAIL_HASH_PEPPER || process.env.JWT_SECRET || "test-only-pepper";
const sign = (payload: string): string => crypto.createHmac("sha256", secret()).update(`submit-ticket:${payload}`).digest("base64url");

export const issueSubmitTicket = (userId: string, formId: string): { ticket: string; expiresInSeconds: number } => {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, f: formId, e: Date.now() + TICKET_LIFETIME_MS, j: crypto.randomBytes(12).toString("hex") })
  ).toString("base64url");
  return { ticket: `${payload}.${sign(payload)}`, expiresInSeconds: TICKET_LIFETIME_MS / 1000 };
};

// Returns the account id the ticket was issued to, or null for ANY problem (malformed, forged, expired,
// issued for another form, already used). Callers treat null as "login required".
export const redeemSubmitTicket = async (ticket: unknown, formId: string): Promise<string | null> => {
  if (typeof ticket !== "string" || ticket.length > 600) return null;
  const [payload, signature] = ticket.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let parsed: { u?: string; f?: string; e?: number; j?: string };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed.u || !parsed.f || !parsed.j || typeof parsed.e !== "number") return null;
  if (parsed.f !== formId || parsed.e < Date.now()) return null;

  // new: false returns the document as it was before, so null means this is the first redemption.
  const before = await RateLimitBucket.findOneAndUpdate(
    { key: `submit-ticket:${parsed.j}` },
    { $setOnInsert: { count: 1, expiresAt: new Date(parsed.e + 60_000) } },
    { upsert: true, new: false }
  ).lean();
  return before ? null : parsed.u;
};
