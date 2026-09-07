import mongoose, { Schema, Document } from "mongoose";
import { WorkspaceRole, NotificationPreference } from "../types/workspace.types";

export interface IMembership extends Document {
  userId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  role: WorkspaceRole;
  notificationPreference: NotificationPreference;
  timezoneOverride?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const MembershipSchema = new Schema<IMembership>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["owner", "admin", "member", "editor", "viewer", "reviewer"],
      default: "member",
      required: true,
    },
    notificationPreference: {
      type: String,
      enum: ["all", "mine", "none"],
      default: "none",
      required: true,
    },
    timezoneOverride: {
      type: String,
      default: null,
      validate: {
        validator: function (v: string | null) {
          if (v === null || v === undefined || v === "") return true;
          try {
            Intl.DateTimeFormat(undefined, { timeZone: v });
            return true;
          } catch {
            return false;
          }
        },
        message: "Invalid IANA timezone string for timezoneOverride",
      },
    },
  },
  {
    timestamps: true,
  }
);

// A user can only have one membership per workspace
MembershipSchema.index({ userId: 1, workspaceId: 1 }, { unique: true });
MembershipSchema.index({ workspaceId: 1, role: 1 });

const Membership = mongoose.model<IMembership>("Membership", MembershipSchema);

export default Membership;
