import mongoose, { Schema, Document } from "mongoose";

// "Anyone with the link, with their email" forms: the respondent proves they own the address BEFORE they submit.
// One record per request. Two separate secrets, both stored only as keyed hashes:
//  - the LINK token travels in the email and proves the inbox (clicking it sets verifiedAt);
//  - the SECRET stays in the respondent's browser and is what the submit redeems, so a forwarded email cannot be
//    used to submit from somewhere else, and the page that clicked the link learns nothing it can submit with.
// A verified record is single use (usedAt) and short-lived (proofExpiresAt).
export interface IEmailVerification extends Document {
  formId: mongoose.Types.ObjectId;
  email: string;
  linkHash: string;
  secretHash: string;
  /** The emailed link works until then. */
  linkExpiresAt: Date;
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
    linkHash: { type: String, required: true, unique: true },
    secretHash: { type: String, required: true, unique: true },
    linkExpiresAt: { type: Date, required: true },
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
