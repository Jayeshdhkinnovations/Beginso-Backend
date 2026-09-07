import mongoose, { Schema, Document } from "mongoose";
import { WorkspaceRole, InvitationStatus } from "../types/workspace.types";

export interface IInvitation extends Document {
  workspaceId: mongoose.Types.ObjectId;
  email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
  token: string;
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
      enum: ["owner", "admin", "member", "editor", "viewer", "reviewer"],
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
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
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
  },
  {
    timestamps: true,
  }
);

// Composite index for finding pending invitations by workspace and email
InvitationSchema.index({ workspaceId: 1, email: 1, status: 1 });

const Invitation = mongoose.model<IInvitation>("Invitation", InvitationSchema);

export default Invitation;
