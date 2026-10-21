import crypto from "crypto";
import mongoose from "mongoose";
import EmailVerification from "../models/EmailVerification";
import { mailService } from "./mail.service";
import { keyedHash } from "../utils/pepper";

// Verifying the respondent's address on a "with their email" (tracked) form. See models/EmailVerification.ts for the two-secret design.

const MINUTE = 60 * 1000;
const minutesEnv = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** How long the emailed link works. */
export const linkLifetimeMs = (): number => minutesEnv("EMAIL_VERIFY_LINK_MINUTES", 30) * MINUTE;
/** After the click, how long the respondent has to finish and submit. */
export const proofLifetimeMs = (): number => minutesEnv("EMAIL_VERIFY_PROOF_MINUTES", 60) * MINUTE;

const appUrl = (): string => process.env.APP_URL || "https://beginso.com";
const hashLink = (t: string): string => keyedHash(`email-verify-link:${t}`);
const hashSecret = (t: string): string => keyedHash(`email-verify-secret:${t}`);

export const isValidEmail = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/** Sends the verification email. The secret is returned once, for the browser that asked; the link token only ever goes by email. */
export const requestVerification = async (params: {
  formId: mongoose.Types.ObjectId | string;
  formName: string;
  email: string;
}): Promise<{ verificationId: string; linkExpiresAt: Date }> => {
  const email = params.email.trim().toLowerCase();
  const linkToken = crypto.randomBytes(32).toString("base64url");
  const secret = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const linkExpiresAt = new Date(now + linkLifetimeMs());
  await EmailVerification.create({
    formId: params.formId,
    email,
    linkHash: hashLink(linkToken),
    secretHash: hashSecret(secret),
    linkExpiresAt,
    purgeAt: new Date(now + linkLifetimeMs() + proofLifetimeMs() + 24 * 60 * MINUTE),
  });
  const sent = await mailService.sendMail({
    to: email,
    template: "respondent_email_verify",
    formName: params.formName,
    actionUrl: `${appUrl()}/confirm-email/${linkToken}`,
    expiresAt: linkExpiresAt,
  });
  if (sent === false) {
    // Nothing was delivered: do not leave a dead request behind, and let the caller say so.
    await EmailVerification.deleteOne({ linkHash: hashLink(linkToken) });
    throw Object.assign(new Error("We could not send the verification email. Please try again."), { statusCode: 502, code: "EMAIL_SEND_FAILED" });
  }
  return { verificationId: secret, linkExpiresAt };
};

export type ConfirmState = "verified" | "expired" | "invalid";

/** The respondent clicked the link in the email. Idempotent: a second click on a verified link still says verified. */
export const confirmLink = async (linkToken: unknown): Promise<{ state: ConfirmState; formId?: string }> => {
  if (typeof linkToken !== "string" || linkToken.length < 20 || linkToken.length > 200) return { state: "invalid" };
  const record = await EmailVerification.findOne({ linkHash: hashLink(linkToken) });
  if (!record) return { state: "invalid" };
  if (record.verifiedAt) return { state: "verified", formId: String(record.formId) };
  if (record.linkExpiresAt.getTime() < Date.now()) return { state: "expired" };
  record.verifiedAt = new Date();
  record.proofExpiresAt = new Date(Date.now() + proofLifetimeMs());
  await record.save();
  return { state: "verified", formId: String(record.formId) };
};

export type VerificationStatus = "pending" | "verified" | "expired" | "invalid";

/** What the respondent's browser polls. Needs the secret, so only the browser that asked can see the answer. */
export const statusOf = async (formId: mongoose.Types.ObjectId | string, secret: unknown): Promise<{ status: VerificationStatus; email?: string }> => {
  if (typeof secret !== "string" || secret.length < 20 || secret.length > 200) return { status: "invalid" };
  const record = await EmailVerification.findOne({ secretHash: hashSecret(secret), formId });
  if (!record || record.usedAt) return { status: "invalid" };
  const now = Date.now();
  if (record.verifiedAt) {
    return record.proofExpiresAt && record.proofExpiresAt.getTime() >= now ? { status: "verified", email: record.email } : { status: "expired" };
  }
  return record.linkExpiresAt.getTime() >= now ? { status: "pending", email: record.email } : { status: "expired" };
};

/** Used by the submit: true once, only for a verified, unexpired, unused record for THIS form and THIS address. */
export const redeem = async (formId: mongoose.Types.ObjectId | string, secret: unknown, email: string): Promise<boolean> => {
  if (typeof secret !== "string" || secret.length < 20 || secret.length > 200) return false;
  const now = new Date();
  const hit = await EmailVerification.findOneAndUpdate(
    {
      secretHash: hashSecret(secret),
      formId,
      email: email.trim().toLowerCase(),
      verifiedAt: { $ne: null },
      proofExpiresAt: { $gte: now },
      usedAt: null,
    },
    { $set: { usedAt: now } }
  );
  return !!hit;
};
