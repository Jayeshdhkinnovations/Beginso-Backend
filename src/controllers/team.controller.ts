import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import Membership from "../models/Membership";
import Workspace from "../models/Workspace";
import User from "../models/User";
import SessionModel from "../models/Session";

// Helper to resolve workspace from param (ObjectId or slug)
const resolveWorkspace = async (paramId: any) => {
  if (!paramId) return null;
  const idStr = String(Array.isArray(paramId) ? paramId[0] : paramId).trim();
  if (mongoose.Types.ObjectId.isValid(idStr)) {
    const ws = await Workspace.findById(idStr);
    if (ws) return ws;
  }
  return await Workspace.findOne({ slug: idStr.toLowerCase() });
};

// Helper to resolve target membership by memberId (which could be Membership _id or User _id)
const resolveTargetMembership = async (workspaceId: mongoose.Types.ObjectId, memberId: any) => {
  const mIdStr = String(Array.isArray(memberId) ? memberId[0] : memberId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(mIdStr)) return null;

  let membership = await Membership.findOne({
    _id: mIdStr,
    workspaceId,
  });

  if (!membership) {
    membership = await Membership.findOne({
      userId: mIdStr,
      workspaceId,
    });
  }

  return membership;
};

export const listMembers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawParam = req.params.id || req.params.workspaceId;
    const rawId = String(Array.isArray(rawParam) ? rawParam[0] : rawParam || "").trim();
    const workspace = await resolveWorkspace(rawId);

    if (!workspace) {
      res.status(404).json({
        success: false,
        message: "Workspace not found",
        error: { message: "Workspace not found" },
      });
      return;
    }

    const memberships = await Membership.find({ workspaceId: workspace._id })
      .populate("userId", "fullName email avatarUrl")
      .lean();

    // Map formatted members
    const membersList = memberships.map((m: any) => {
      const userObj = m.userId || {};
      const fullName = userObj.fullName || "Team Member";
      const email = userObj.email || "";
      return {
        id: m._id.toString(),
        _id: m._id,
        userId: userObj._id ? userObj._id.toString() : m.userId?.toString(),
        name: fullName,
        fullName: fullName,
        email: email,
        user: {
          id: userObj._id ? userObj._id.toString() : "",
          fullName: fullName,
          name: fullName,
          email: email,
          avatarUrl: userObj.avatarUrl || null,
        },
        role: m.role,
        joinedAt: m.createdAt,
        notificationPreference: m.notificationPreference,
        timezoneOverride: m.timezoneOverride || null,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      };
    });

    // If workspace owner does not have an explicit Membership row, synthesize it
    const hasOwnerInList = membersList.some((m) => m.role === "owner" || m.userId === workspace.owner.toString());
    if (!hasOwnerInList) {
      const ownerUser: any = await User.findById(workspace.owner).select("fullName email avatarUrl").lean();
      if (ownerUser) {
        membersList.unshift({
          id: `owner-${workspace._id.toString()}`,
          _id: workspace.owner,
          userId: workspace.owner.toString(),
          name: ownerUser.fullName || "Owner",
          fullName: ownerUser.fullName || "Owner",
          email: ownerUser.email || "",
          user: {
            id: workspace.owner.toString(),
            fullName: ownerUser.fullName || "Owner",
            name: ownerUser.fullName || "Owner",
            email: ownerUser.email || "",
            avatarUrl: ownerUser.avatarUrl || null,
          },
          role: "owner",
          joinedAt: workspace.createdAt,
          notificationPreference: "all" as any,
          timezoneOverride: null,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        });
      }
    }

    res.status(200).json({
      success: true,
      members: membersList,
      total: membersList.length,
      data: membersList,
    });
  } catch (error) {
    next(error);
  }
};

export const updateMemberRole = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawParam = req.params.id || req.params.workspaceId;
    const rawId = String(Array.isArray(rawParam) ? rawParam[0] : rawParam || "").trim();
    const workspace = await resolveWorkspace(rawId);

    if (!workspace) {
      res.status(404).json({
        success: false,
        message: "Workspace not found",
        error: { message: "Workspace not found" },
      });
      return;
    }

    const rawMember = req.params.memberId;
    const memberId = String(Array.isArray(rawMember) ? rawMember[0] : rawMember || "").trim();
    const { role } = req.body;

    if (!role) {
      res.status(400).json({
        success: false,
        message: "Role is required",
        error: { message: "Role is required" },
      });
      return;
    }

    const validRoles = ["admin", "editor", "member", "reviewer", "viewer"];
    if (!validRoles.includes(role)) {
      res.status(400).json({
        success: false,
        message: `Invalid role: must be one of ${validRoles.join(", ")}`,
        error: { message: `Invalid role: must be one of ${validRoles.join(", ")}` },
      });
      return;
    }

    const membership = await resolveTargetMembership(workspace._id as mongoose.Types.ObjectId, memberId);
    if (!membership) {
      res.status(404).json({
        success: false,
        message: "Member not found in this workspace",
        error: { message: "Member not found in this workspace" },
      });
      return;
    }

    // Guard: Reject target who is the workspace's owner
    const targetUserId = membership.userId.toString();
    const isTargetOwner = workspace.owner.toString() === targetUserId || membership.role === "owner";

    if (isTargetOwner) {
      res.status(400).json({
        success: false,
        message: "Cannot change the role of the workspace owner",
        error: {
          code: "CANNOT_MODIFY_WORKSPACE_OWNER",
          message: "Cannot change the role of the workspace owner",
        },
      });
      return;
    }

    membership.role = role as any;
    await membership.save();

    // BE 0.8: Invalidate target user's active session(s) immediately
    await SessionModel.updateMany(
      {
        userId: membership.userId,
        $or: [{ revokedAt: null }, { revokedAt: { $exists: false } }],
      },
      { $set: { revokedAt: new Date() } }
    );

    const memberData = {
      id: membership._id.toString(),
      userId: membership.userId.toString(),
      role: membership.role,
      notificationPreference: membership.notificationPreference,
      updatedAt: membership.updatedAt,
    };

    res.status(200).json({
      success: true,
      message: "Member role updated successfully",
      member: memberData,
      membership: memberData,
      data: memberData,
    });
  } catch (error) {
    next(error);
  }
};

export const removeMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawParam = req.params.id || req.params.workspaceId;
    const rawId = String(Array.isArray(rawParam) ? rawParam[0] : rawParam || "").trim();
    const workspace = await resolveWorkspace(rawId);

    if (!workspace) {
      res.status(404).json({
        success: false,
        message: "Workspace not found",
        error: { message: "Workspace not found" },
      });
      return;
    }

    const rawMember = req.params.memberId;
    const memberId = String(Array.isArray(rawMember) ? rawMember[0] : rawMember || "").trim();
    const membership = await resolveTargetMembership(workspace._id as mongoose.Types.ObjectId, memberId);

    if (!membership) {
      res.status(404).json({
        success: false,
        message: "Member not found in this workspace",
        error: { message: "Member not found in this workspace" },
      });
      return;
    }

    const targetUserId = membership.userId.toString();
    const isTargetOwner = workspace.owner.toString() === targetUserId || membership.role === "owner";

    // Guard: Reject target who is the workspace's owner
    if (isTargetOwner) {
      res.status(400).json({
        success: false,
        message: "Cannot remove the workspace owner",
        error: {
          code: "CANNOT_REMOVE_WORKSPACE_OWNER",
          message: "Cannot remove the workspace owner",
        },
      });
      return;
    }

    // Guard: Reject removing the workspace's last remaining member
    const totalMembers = await Membership.countDocuments({ workspaceId: workspace._id });
    if (totalMembers <= 1) {
      res.status(400).json({
        success: false,
        message: "Cannot remove the last remaining member of the workspace",
        error: {
          code: "CANNOT_REMOVE_LAST_MEMBER",
          message: "Cannot remove the last remaining member of the workspace",
        },
      });
      return;
    }

    await Membership.findByIdAndDelete(membership._id);

    // BE 0.8: Invalidate target user's active session(s) immediately
    await SessionModel.updateMany(
      {
        userId: membership.userId,
        $or: [{ revokedAt: null }, { revokedAt: { $exists: false } }],
      },
      { $set: { revokedAt: new Date() } }
    );

    res.status(200).json({
      success: true,
      message: "Member removed successfully",
    });
  } catch (error) {
    next(error);
  }
};
