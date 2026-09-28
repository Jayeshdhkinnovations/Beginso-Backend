import mongoose, { Schema, Document } from "mongoose";
import { WorkspaceRole, InvitationStatus } from "../types/workspace.types";

export interface IInvitation extends Document {
  workspaceId: mongoose.Types.ObjectId;
  email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
  token?: string;
  tokenHash?: string;
  purgeAt?: Date;
  expiresAt: Date;
  invitedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const InvitationSchema = new Schema<IInvitation>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["admin", "member", "editor", "viewer", "reviewer"],
      default: "member",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "revoked", "expired"],
      default: "pending",
      required: true,
      index: true,
    },
    // Legacy: invitations created before hashing hold the plain token here. New ones never do.
    token: {
      type: String,
      unique: true,
      sparse: true,
    },
    // SHA-256 of the token in the emailed link (see utils/invitationToken.ts).
    tokenHash: {
      type: String,
      unique: true,
      sparse: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    invitedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    // When MongoDB deletes the row: 30 days after it expired (see the TTL index below).
    purgeAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

// Expired invitations are removed automatically 30 days after their expiry. A separate field is
// used because `expiresAt` already carries a plain index, and MongoDB will not change an existing
// index into a TTL one in place.
InvitationSchema.pre("save", function () {
  if (this.isNew || this.isModified("expiresAt")) {
    this.purgeAt = new Date(new Date(this.expiresAt).getTime() + 30 * 24 * 60 * 60 * 1000);
  }
});
InvitationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

// Composite index for finding pending invitations by workspace and email
InvitationSchema.index({ workspaceId: 1, email: 1, status: 1 });
// At most one pending invitation per workspace and email, even under concurrent sends.
InvitationSchema.index(
  { workspaceId: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

const Invitation = mongoose.model<IInvitation>("Invitation", InvitationSchema);

export default Invitation;
