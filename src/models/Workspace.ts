import mongoose, { Schema, Document } from "mongoose";
export interface INotificationPreferences {
  newResponseEmail: boolean;
  weeklyDigestEmail: boolean;
  productUpdatesEmail: boolean;
}

import crypto from "crypto";

export interface IWorkspace extends Document {
  name: string;
  slug: string;
  timezone: string;
  description?: string;
  logo?: string;
  logoUrl?: string | null;
  branding?: Record<string, any>;
  notificationPreferences?: INotificationPreferences;
  owner: mongoose.Types.ObjectId;
  status: "active" | "suspended" | "deleted";
  createdAt: Date;
  updatedAt: Date;
}
const WorkspaceSchema = new Schema<IWorkspace>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    timezone: {
      type: String,
      default: "UTC",
      trim: true,
      validate: {
        validator: function (v: string) {
          if (!v) return false;
          try {
            Intl.DateTimeFormat(undefined, { timeZone: v });
            return true;
          } catch {
            return false;
          }
        },
        message: "Invalid IANA timezone string",
      },
    },

    description: {
      type: String,
      default: "",
    },

    logo: {
      type: String,
      default: "",
    },

    logoUrl: {
      type: String,
      default: null,
    },

    branding: {
      type: Schema.Types.Mixed,
      default: {},
    },

    notificationPreferences: {
      newResponseEmail: { type: Boolean, default: true },
      weeklyDigestEmail: { type: Boolean, default: true },
      productUpdatesEmail: { type: Boolean, default: false },
    },

    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    status: {
      type: String,
      default: "active",
    },
  },
  {
    timestamps: true,
  }
);

// Auto-generate slug if not provided before validation
WorkspaceSchema.pre("validate", function () {
  if (!this.slug && this.name) {
    const baseSlug = this.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
    const suffix = crypto.randomBytes(3).toString("hex");
    this.slug = `${baseSlug}-${suffix}`;
  }
});

const Workspace = mongoose.model<IWorkspace>(
  "Workspace",
  WorkspaceSchema
);

export default Workspace;