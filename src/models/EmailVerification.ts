import mongoose, { Schema, Document } from "mongoose";

// Forms that ask for a verified email ("Anyone, with a verified email"): the respondent proves they own the address BEFORE the form
// starts, with a 6-digit code sent to it. One record per request. Two secrets, both stored only as keyed hashes:
//  - the CODE travels in the email and proves the inbox;
//  - the SECRET (the "verification id") stays in the respondent's browser and is what the submit redeems, so a code read over someone's
//    shoulder cannot be used from another browser.
// Guessing is capped (MAX_ATTEMPTS wrong codes kill the request); a verified record is single use (usedAt) and short-lived.
export interface IEmailVerification extends Document {
  formId: mongoose.Types.ObjectId;
  email: string;
  codeHash: string;
  secretHash: string;
  attempts: number;
  /** The code works until then. */
  expiresAt: Date;
  verifiedAt?: Date | null;
  /** Once verified, the submission has until then to redeem it. */
  proofExpiresAt?: Date | null;
  usedAt?: Date | null;
  purgeAt: Date;
  createdAt: Date;
}

const EmailVerificationSchema = new Schema<IEmailVerification>(
  {
    formId: { type: Schema.Types.ObjectId, ref: "Form", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    codeHash: { type: String, required: true },
    secretHash: { type: String, required: true, unique: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    verifiedAt: { type: Date, default: null },
    proofExpiresAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

EmailVerificationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

const EmailVerification = mongoose.model<IEmailVerification>("EmailVerification", EmailVerificationSchema);
export default EmailVerification;
