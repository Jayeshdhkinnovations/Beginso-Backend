import mongoose, { Schema, Document } from "mongoose";
import crypto from "crypto";
import { keyedHash } from "../utils/pepper";

export type MailLogTemplate =
  | "verification"
  | "password_reset"
  | "welcome"
  // Sprint 14 (R1): in-product activity emails. Never contain answers, attachments or questions.
  | "new_response"
  | "mention"
  | "assignment";

export interface IMailLog extends Document {
  template: MailLogTemplate;
  outcome: "sent" | "failed" | "queued" | "rate_limited";
  emailHash: string;
  firebaseUid?: string;
  requestId: string;
  // Sprint 14: idempotency key for notification emails (one row per event + recipient). Unique when present.
  dedupeKey?: string;
  provider: "resend" | "sendgrid" | "ses" | "postmark" | "smtp";
  errorCode?: string;
  latencyMs?: number;
  createdAt: Date;
}

const MailLogSchema = new Schema<IMailLog>(
  {
    template: {
      type: String,
      enum: ["verification", "password_reset", "welcome", "new_response", "mention", "assignment"],
      required: true,
      index: true,
    },
    outcome: {
      type: String,
      enum: ["sent", "failed", "queued", "rate_limited"],
      required: true,
      index: true,
    },
    emailHash: {
      type: String,
      required: true,
      index: true,
    },
    firebaseUid: {
      type: String,
      index: true,
    },
    requestId: {
      type: String,
      required: true,
      index: true,
    },
    dedupeKey: { type: String },
    provider: {
      type: String,
      enum: ["resend", "sendgrid", "ses", "postmark", "smtp"],
      required: true,
      default: "smtp",
    },
    errorCode: {
      type: String,
    },
    latencyMs: {
      type: Number,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: "30d", // 30-day TTL purge, matches system_logs
    },
  },
  {
    timestamps: false,
  }
);

MailLogSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });

export const MailLog = mongoose.model<IMailLog>("MailLog", MailLogSchema);

export const computeEmailHash = (email: string): string => {
  const normalized = (email || "").trim().toLowerCase();
  return keyedHash(normalized);
};

export const recordMailLog = async (data: {
  template: MailLogTemplate;
  outcome: "sent" | "failed" | "queued" | "rate_limited";
  email: string;
  firebaseUid?: string;
  requestId?: string;
  provider?: "resend" | "sendgrid" | "ses" | "postmark" | "smtp";
  errorCode?: string;
  latencyMs?: number;
}): Promise<IMailLog | null> => {
  try {
    const emailHash = computeEmailHash(data.email);
    const reqId = data.requestId || `req_${crypto.randomBytes(8).toString("hex")}`;
    return await MailLog.create({
      template: data.template,
      outcome: data.outcome,
      emailHash,
      firebaseUid: data.firebaseUid,
      requestId: reqId,
      provider: data.provider || "smtp",
      errorCode: data.errorCode,
      latencyMs: data.latencyMs,
    });
  } catch (err) {
    console.error("Failed to write MailLog:", err);
    return null;
  }
};
