import mongoose, { Schema, Document } from "mongoose";

// Sprint 13, BE 0.10 (A5.3 / A5.4). A signed link that lets ONE respondent view and correct ONE
// response without a member session. The token itself is never stored - only its keyed hash - so a
// database leak does not yield working links. One token = one response; viewing and editing are
// repeatable until `expiresAt`; creating an account from it is single-use (`claimedAt`).
export interface IRespondentLink extends Document {
  tokenHash: string;
  responseId: mongoose.Types.ObjectId;
  formId: mongoose.Types.ObjectId;
  // The address the link was sent to (lower-cased). Account claim requires the signed-in email to match.
  email: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  claimedAt?: Date | null;
  claimedByUserId?: mongoose.Types.ObjectId | null;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const RespondentLinkSchema = new Schema<IRespondentLink>(
  {
    tokenHash: { type: String, required: true, unique: true },
    responseId: { type: Schema.Types.ObjectId, ref: "Response", required: true, index: true },
    formId: { type: Schema.Types.ObjectId, ref: "Form", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    claimedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const RespondentLink = mongoose.model<IRespondentLink>("RespondentLink", RespondentLinkSchema);
export default RespondentLink;
