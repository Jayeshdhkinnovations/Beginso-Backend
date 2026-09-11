import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import Invitation from "../models/Invitation";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import User from "../models/User";
import { mailService } from "../services/mail.service";

// Helper to resolve workspace
const resolveWorkspace = async (paramId: any) => {
  if (!paramId) return null;
  const idStr = String(Array.isArray(paramId) ? paramId[0] : paramId).trim();
  if (mongoose.Types.ObjectId.isValid(idStr)) {
    const ws = await Workspace.findById(idStr);
    if (ws) return ws;
  }
  return await Workspace.findOne({ slug: idStr.toLowerCase() });
};

// GET /api/workspaces/:id/invitations or GET /api/invitations
export const listInvitations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    const rawWsId = req.params.id || req.params.workspaceId || req.query.workspaceId || authReq.workspaceId;
    const workspace = await resolveWorkspace(rawWsId);

    if (!workspace) {
      res.status(404).json({
        success: false,
        message: "Workspace not found",
        error: { message: "Workspace not found" },
      });
      return;
    }

    const invitations = await Invitation.find({ workspaceId: workspace._id })
      .populate("invitedBy", "fullName email")
      .sort({ createdAt: -1 })
      .lean();

    const formatted = invitations.map((inv: any) => {
      const isExpired = inv.status === "pending" && inv.expiresAt && new Date(inv.expiresAt) < new Date();
      const status = isExpired ? "expired" : inv.status;

      return {
        id: inv._id.toString(),
        _id: inv._id,
        workspaceId: inv.workspaceId.toString(),
        email: inv.email,
        role: inv.role,
        status,
        token: inv.token,
        expiresAt: inv.expiresAt,
        invitedBy: inv.invitedBy
          ? {
              id: inv.invitedBy._id ? inv.invitedBy._id.toString() : inv.invitedBy.toString(),
              fullName: inv.invitedBy.fullName || "Team Member",
              email: inv.invitedBy.email || "",
            }
          : null,
        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
      };
    });

    res.status(200).json({
      success: true,
      invitations: formatted,
      total: formatted.length,
      data: formatted,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/workspaces/:id/invitations or POST /api/invitations
export const sendInvitation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    const rawWsId = req.params.id || req.params.workspaceId || req.body.workspaceId || authReq.workspaceId;
    const workspace = await resolveWorkspace(rawWsId);

    if (!workspace) {
      res.status(404).json({
        success: false,
        message: "Workspace not found",
        error: { message: "Workspace not found" },
      });
      return;
    }

    const { email, role } = req.body;
    if (!email || typeof email !== "string") {
      res.status(400).json({
        success: false,
        message: "Email is required",
        error: { message: "Email is required" },
      });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const assignedRole = role || "member";
    const validRoles = ["admin", "editor", "member", "reviewer", "viewer"];
    if (!validRoles.includes(assignedRole)) {
      res.status(400).json({
        success: false,
        message: `Invalid role: must be one of ${validRoles.join(", ")}`,
        error: { message: `Invalid role: must be one of ${validRoles.join(", ")}` },
      });
      return;
    }

    // Check if target user is already a member or owner of the workspace
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      const isOwner = workspace.owner.toString() === existingUser._id.toString();
      const existingMember = await Membership.findOne({
        workspaceId: workspace._id,
        userId: existingUser._id,
      });

      if (isOwner || existingMember) {
        res.status(400).json({
          success: false,
          message: "User is already a member of this workspace",
          error: {
            code: "ALREADY_MEMBER",
            message: "User is already a member of this workspace",
          },
        });
        return;
      }
    }

    // BE 0.3: An email with an existing pending invitation gets that row updated, not a duplicate row created
    const existingInv = await Invitation.findOne({
      workspaceId: workspace._id,
      email: normalizedEmail,
      status: "pending",
    });

    const appUrl = process.env.APP_URL || "https://beginso.com";

    if (existingInv) {
      existingInv.role = assignedRole;
      existingInv.invitedBy = authReq.user._id;
      await existingInv.save();

      // Send email asynchronously
      const inviteUrl = `${appUrl}/invite/${existingInv.token}`;
      mailService
        .sendMail({
          to: normalizedEmail,
          template: "welcome_user" as any,
          name: normalizedEmail,
          actionUrl: inviteUrl,
        })
        .catch(() => {});

      res.status(200).json({
        success: true,
        message: "Invitation updated successfully",
        invitation: existingInv,
      });
      return;
    }

    // Create new invitation with unique token and 7-day expiry
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invitation = await Invitation.create({
      workspaceId: workspace._id,
      email: normalizedEmail,
      role: assignedRole,
      status: "pending",
      token,
      expiresAt,
      invitedBy: authReq.user._id,
    });

    const inviteUrl = `${appUrl}/invite/${token}`;
    mailService
      .sendMail({
        to: normalizedEmail,
        template: "welcome_user" as any,
        name: normalizedEmail,
        actionUrl: inviteUrl,
      })
      .catch(() => {});

    res.status(201).json({
      success: true,
      message: "Invitation sent successfully",
      invitation,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/invitations/:id/resend
export const resendInvitation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawParam = req.params.invitationId || req.params.id;
    const rawId = String(Array.isArray(rawParam) ? rawParam[0] : rawParam || "").trim();
    let invitation: any = null;

    if (mongoose.Types.ObjectId.isValid(rawId)) {
      invitation = await Invitation.findById(rawId);
    }
    if (!invitation) {
      invitation = await Invitation.findOne({ token: rawId });
    }

    if (!invitation) {
      res.status(404).json({
        success: false,
        message: "Invitation not found",
        error: { message: "Invitation not found" },
      });
      return;
    }

    if (invitation.status === "revoked") {
      res.status(400).json({
        success: false,
        message: "Cannot resend a revoked invitation",
        error: { message: "Cannot resend a revoked invitation" },
      });
      return;
    }

    // BE 0.3: Resend does NOT change the existing expiry
    const appUrl = process.env.APP_URL || "https://beginso.com";
    const inviteUrl = `${appUrl}/invite/${invitation.token}`;
    mailService
      .sendMail({
        to: invitation.email,
        template: "welcome_user" as any,
        name: invitation.email,
        actionUrl: inviteUrl,
      })
      .catch(() => {});

    res.status(200).json({
      success: true,
      message: "Invitation resent successfully",
      invitation,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/invitations/:id/revoke or DELETE /api/invitations/:id
export const revokeInvitation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawParam = req.params.invitationId || req.params.id;
    const rawId = String(Array.isArray(rawParam) ? rawParam[0] : rawParam || "").trim();
    let invitation: any = null;

    if (mongoose.Types.ObjectId.isValid(rawId)) {
      invitation = await Invitation.findById(rawId);
    }
    if (!invitation) {
      invitation = await Invitation.findOne({ token: rawId });
    }

    if (!invitation) {
      res.status(404).json({
        success: false,
        message: "Invitation not found",
        error: { message: "Invitation not found" },
      });
      return;
    }

    // BE 0.3: Revoke sets status: 'revoked' rather than deleting the row
    invitation.status = "revoked";
    await invitation.save();

    res.status(200).json({
      success: true,
      message: "Invitation revoked successfully",
      invitation,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/invitations/:token or GET /api/invitations/:token/preview (BE 0.4: Public preview, no auth)
export const previewInvitation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { token } = req.params;
    const invitation = await Invitation.findOne({ token });

    if (!invitation) {
      res.status(404).json({
        success: false,
        message: "Invitation not found",
        error: { code: "INVITATION_NOT_FOUND", message: "Invitation not found" },
      });
      return;
    }

    // Check expiry
    const isExpired = invitation.status === "pending" && invitation.expiresAt && new Date(invitation.expiresAt) < new Date();
    const effectiveStatus = isExpired ? "expired" : invitation.status;

    // Resolve workspace name strictly
    const workspace = await Workspace.findById(invitation.workspaceId).select("name").lean();
    const workspaceName = workspace ? workspace.name : "Workspace";

    // Resolve inviter name strictly
    let inviterName = "Beginso Team";
    if (invitation.invitedBy) {
      const inviter = await User.findById(invitation.invitedBy).select("fullName").lean();
      if (inviter && inviter.fullName) {
        inviterName = inviter.fullName;
      }
    }

    // Check callerEmailMatches via optional Bearer token or cookie
    let callerEmailMatches = false;
    let callerToken: string | undefined;

    const authHeader = req.headers.authorization || (req.headers as any).Authorization;
    if (authHeader && typeof authHeader === "string") {
      const parts = authHeader.trim().split(" ");
      callerToken = parts.length === 2 ? parts[1] : parts[0];
    }
    if (!callerToken && req.headers.cookie) {
      const cookies = req.headers.cookie.split(";").reduce((acc, c) => {
        const [name, ...val] = c.trim().split("=");
        acc[name] = val.join("=");
        return acc;
      }, {} as Record<string, string>);
      callerToken = cookies.token || cookies.jwt || cookies.access_token;
    }

    if (callerToken && callerToken !== "undefined" && callerToken !== "null") {
      try {
        const decoded = jwt.verify(callerToken, process.env.JWT_SECRET as string) as any;
        if (decoded && decoded.email) {
          callerEmailMatches = decoded.email.toLowerCase() === invitation.email.toLowerCase();
        }
      } catch {
        callerEmailMatches = false;
      }
    }

    // BE 0.4 Guarantee: returns ONLY { workspaceName, inviterName, role, status, invitedEmail, callerEmailMatches }
    const previewData = {
      workspaceName,
      inviterName,
      role: invitation.role,
      status: effectiveStatus,
      invitedEmail: invitation.email,
      callerEmailMatches,
    };

    res.status(200).json({
      success: true,
      invitation: previewData,
      ...previewData,
      data: previewData,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/invitations/:token/accept (BE 0.4: Authenticated)
export const acceptInvitation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" },
      });
      return;
    }

    const { token } = req.params;
    const invitation = await Invitation.findOne({ token });

    if (!invitation) {
      res.status(404).json({
        success: false,
        message: "Invitation not found",
        error: { code: "INVITATION_NOT_FOUND", message: "Invitation not found" },
      });
      return;
    }

    const callerEmail = authReq.user.email.toLowerCase();
    const invitedEmail = invitation.email.toLowerCase();

    // BE 0.4 Guarantee: email mismatch returns a distinguishable 403, not a generic error
    if (callerEmail !== invitedEmail) {
      res.status(403).json({
        success: false,
        message: "Email mismatch: signed in as a different account than the one invited",
        error: {
          code: "EMAIL_MISMATCH",
          message: "Email mismatch: signed in as a different account than the one invited",
        },
      });
      return;
    }

    if (invitation.status === "revoked") {
      res.status(400).json({
        success: false,
        message: "This invitation has been revoked",
        error: {
          code: "INVITATION_REVOKED",
          message: "This invitation has been revoked",
        },
      });
      return;
    }

    const isExpired = invitation.expiresAt && new Date(invitation.expiresAt) < new Date();
    if (invitation.status === "expired" || isExpired) {
      invitation.status = "expired";
      await invitation.save();
      res.status(400).json({
        success: false,
        message: "This invitation has expired",
        error: {
          code: "INVITATION_EXPIRED",
          message: "This invitation has expired",
        },
      });
      return;
    }

    // BE 0.4 Guarantee: accept is idempotent (200, not 409) when caller is already a member
    const existingMembership = await Membership.findOne({
      workspaceId: invitation.workspaceId,
      userId: authReq.user._id,
    });

    if (existingMembership) {
      invitation.status = "accepted";
      await invitation.save();

      res.status(200).json({
        success: true,
        message: "Invitation accepted",
        workspaceId: invitation.workspaceId.toString(),
        membership: existingMembership,
      });
      return;
    }

    // Create membership
    const membership = await Membership.create({
      userId: authReq.user._id,
      workspaceId: invitation.workspaceId,
      role: invitation.role,
      notificationPreference: "mine",
      timezoneOverride: null,
    });

    // Link user active workspaceId if unset
    if (!authReq.user.workspaceId) {
      authReq.user.workspaceId = invitation.workspaceId;
      await authReq.user.save();
    }

    invitation.status = "accepted";
    await invitation.save();

    res.status(200).json({
      success: true,
      message: "Invitation accepted successfully",
      workspaceId: invitation.workspaceId.toString(),
      membership,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/invitations/:token/decline
export const declineInvitation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    const { token } = req.params;
    const invitation = await Invitation.findOne({ token });

    if (!invitation) {
      res.status(404).json({
        success: false,
        message: "Invitation not found",
        error: { code: "INVITATION_NOT_FOUND", message: "Invitation not found" },
      });
      return;
    }

    // If caller is authenticated, enforce email match
    if (authReq.user) {
      const callerEmail = authReq.user.email.toLowerCase();
      const invitedEmail = invitation.email.toLowerCase();
      if (callerEmail !== invitedEmail) {
        res.status(403).json({
          success: false,
          message: "Email mismatch: signed in as a different account than the one invited",
          error: {
            code: "EMAIL_MISMATCH",
            message: "Email mismatch: signed in as a different account than the one invited",
          },
        });
        return;
      }
    }

    invitation.status = "declined";
    await invitation.save();

    res.status(200).json({
      success: true,
      message: "Invitation declined successfully",
    });
  } catch (error) {
    next(error);
  }
};
