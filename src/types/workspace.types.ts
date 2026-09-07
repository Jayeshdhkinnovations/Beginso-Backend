import { Types } from "mongoose";

export type WorkspaceRole = "owner" | "admin" | "member" | "editor" | "viewer" | "reviewer";

export type NotificationPreference = "all" | "mine" | "none";

export type InvitationStatus = "pending" | "accepted" | "declined" | "revoked" | "expired";

export interface IWorkspaceBase {
  name: string;
  slug: string;
  timezone: string;
  description?: string;
  logo?: string;
  logoUrl?: string | null;
  branding?: Record<string, any>;
  owner: Types.ObjectId | string;
  status: "active";
}

export interface IMembershipBase {
  userId: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  role: WorkspaceRole;
  notificationPreference: NotificationPreference;
  timezoneOverride?: string | null;
}

export interface IInvitationBase {
  workspaceId: Types.ObjectId | string;
  email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
  token: string;
  expiresAt: Date;
  invitedBy?: Types.ObjectId | string;
}

export interface AssigneeRef {
  userId: Types.ObjectId | string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}
