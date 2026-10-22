import crypto from "crypto";
import mongoose from "mongoose";
import EmailVerification from "../models/EmailVerification";
import { mailService } from "./mail.service";
import { keyedHash } from "../utils/pepper";

// Verifying the respondent's address before the form starts. See models/EmailVerification.ts for the two-secret design.

const MINUTE = 60 * 1000;
const minutesEnv = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** How long the emailed code works. */
export const codeLifetimeMs = (): number => minutesEnv("EMAIL_VERIFY_CODE_MINUTES", 10) * MINUTE;
/** After the code is accepted, how long the respondent has to finish and submit. */
export const proofLifetimeMs = (): number => minutesEnv("EMAIL_VERIFY_PROOF_MINUTES", 120) * MINUTE;
export const MAX_ATTEMPTS = 5;

const hashCode = (secret: string, code: string): string => keyedHash(`email-verify-code:${secret}:${code}`);
const hashSecret = (secret: string): string => keyedHash(`email-verify-secret:${secret}`);

export const isValidEmail = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

const validSecret = (s: unknown): s is string => typeof s === "string" && s.length >= 20 && s.length <= 200;

/** Sends the 6-digit code. The secret is returned once, for the browser that asked; the code only ever goes by email. */
export const requestVerification = async (params: {
  formId: mongoose.Types.ObjectId | string;
  formName: string;
  email: string;
}): Promise<{ verificationId: string; expiresAt: Date }> => {
  const email = params.email.trim().toLowerCase();
  const secret = crypto.randomBytes(32).toString("base64url");
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const now = Date.now();
  const expiresAt = new Date(now + codeLifetimeMs());
  await EmailVerification.create({
    formId: params.formId,
    email,
    codeHash: hashCode(secret, code),
    secretHash: hashSecret(secret),
    expiresAt,
    purgeAt: new Date(now + codeLifetimeMs() + proofLifetimeMs() + 24 * 60 * MINUTE),
  });
  const sent = await mailService.sendMail({
    to: email,
    template: "respondent_email_code",
    formName: params.formName,
    code,
    expiresAt,
  });
  if (sent === false) {
    // Nothing was delivered: do not leave a dead request behind, and let the caller say so.
    await EmailVerification.deleteOne({ secretHash: hashSecret(secret) });
    throw Object.assign(new Error("We could not send the verification email. Please try again."), { statusCode: 502, code: "EMAIL_SEND_FAILED" });
  }
  return { verificationId: secret, expiresAt };
};

export type CodeResult =
  | { state: "verified"; email: string }
  | { state: "wrong"; attemptsLeft: number }
  | { state: "locked" | "expired" | "invalid" };

/** The respondent typed the code. Idempotent once accepted. At most MAX_ATTEMPTS wrong tries, then the request is dead. */
export const verifyCode = async (formId: mongoose.Types.ObjectId | string, secret: unknown, code: unknown): Promise<CodeResult> => {
  if (!validSecret(secret)) return { state: "invalid" };
  const record = await EmailVerification.findOne({ secretHash: hashSecret(secret), formId });
  if (!record || record.usedAt) return { state: "invalid" };
  if (record.verifiedAt) return { state: "verified", email: record.email };
  if (record.expiresAt.getTime() < Date.now()) return { state: "expired" };
  if (record.attempts >= MAX_ATTEMPTS) return { state: "locked" };
  const typed = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  const expected = Buffer.from(record.codeHash);
  const given = Buffer.from(hashCode(secret, typed));
  if (/^\d{6}$/.test(typed) && expected.length === given.length && crypto.timingSafeEqual(expected, given)) {
    // Atomic: of two simultaneous right answers only one flips verifiedAt.
    const now = new Date();
    await EmailVerification.updateOne(
      { _id: record._id, verifiedAt: null },
      { $set: { verifiedAt: now, proofExpiresAt: new Date(now.getTime() + proofLifetimeMs()) } }
    );
    return { state: "verified", email: record.email };
  }
  const updated = await EmailVerification.findOneAndUpdate({ _id: record._id }, { $inc: { attempts: 1 } }, { new: true });
  const used = updated?.attempts ?? record.attempts + 1;
  return used >= MAX_ATTEMPTS ? { state: "locked" } : { state: "wrong", attemptsLeft: MAX_ATTEMPTS - used };
};

/** Used by the submit: true once, only for a verified, unexpired, unused record for THIS form. Returns the verified address, or null. */
export const redeem = async (formId: mongoose.Types.ObjectId | string, secret: unknown): Promise<string | null> => {
  if (!validSecret(secret)) return null;
  const now = new Date();
  const hit = await EmailVerification.findOneAndUpdate(
    {
      secretHash: hashSecret(secret),
      formId,
      verifiedAt: { $ne: null },
      proofExpiresAt: { $gte: now },
      usedAt: null,
    },
    { $set: { usedAt: now } }
  );
  return hit ? hit.email : null;
};
