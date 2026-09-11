import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import Workspace from "../models/Workspace";
import User from "../models/User";
import Membership from "../models/Membership";

export const createWorkspace = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const { name, slug, timezone, description, logo } = req.body;
    if (!name) {
      res.status(400).json({ success: false, message: "Workspace name is required" });
      return;
    }

    if (timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
      } catch {
        res.status(400).json({
          success: false,
          message: "Invalid timezone: must be a valid IANA timezone string",
          error: { message: "Invalid timezone: must be a valid IANA timezone string" },
        });
        return;
      }
    }

    const workspaceData: any = {
      name,
      description,
      logo,
      owner: authReq.user._id,
      timezone: timezone || "UTC",
    };

    if (slug) {
      workspaceData.slug = slug.toLowerCase().trim();
    }

    const workspace = await Workspace.create(workspaceData);

    // Create owner membership for creator
    await Membership.create({
      userId: authReq.user._id,
      workspaceId: workspace._id,
      role: "owner",
      notificationPreference: "all",
      timezoneOverride: null,
    });

    // Update user's active workspace if not yet set
    const user = await User.findById(authReq.user._id);
    if (user && !user.workspaceId) {
      user.workspaceId = workspace._id as any;
      await user.save();
    }

    res.status(201).json({
      success: true,
      message: "Workspace created successfully",
      workspace,
    });
  } catch (error: any) {
    if (error.code === 11000 && error.keyPattern?.slug) {
      res.status(409).json({
        success: false,
        message: "A workspace with this slug already exists",
        error: { message: "A workspace with this slug already exists" },
      });
      return;
    }
    next(error);
  }
};

export const listWorkspaces = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const userId = authReq.user._id;

    // 1. Find all memberships for caller
    const memberships = await Membership.find({ userId }).lean();
    const membershipMap = new Map<string, any>();
    for (const m of memberships) {
      membershipMap.set(m.workspaceId.toString(), m);
    }

    // 2. Also find any legacy workspaces where caller is owner
    const ownedWorkspaces = await Workspace.find({ owner: userId }).lean();
    for (const ow of ownedWorkspaces) {
      if (!membershipMap.has(ow._id.toString())) {
        membershipMap.set(ow._id.toString(), {
          userId,
          workspaceId: ow._id,
          role: "owner",
          notificationPreference: "all",
          timezoneOverride: null,
        });
      }
    }

    const workspaceIds = Array.from(membershipMap.keys());
    const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }).lean();

    // 3. Count members per workspace in a single aggregation
    const memberCounts = await Membership.aggregate([
      { $match: { workspaceId: { $in: workspaces.map((w: any) => w._id) } } },
      { $group: { _id: "$workspaceId", count: { $sum: 1 } } },
    ]);
    const countMap = new Map<string, number>();
    for (const mc of memberCounts) {
      countMap.set(mc._id.toString(), mc.count);
    }

    const result = workspaces.map((ws: any) => {
      const m = membershipMap.get(ws._id.toString());
      const role = m?.role || (ws.owner.toString() === userId.toString() ? "owner" : "member");
      const isOwner = ws.owner.toString() === userId.toString() || role === "owner";
      const memberCount = Math.max(countMap.get(ws._id.toString()) || 0, isOwner ? 1 : 0);

      return {
        _id: ws._id,
        id: ws._id.toString(),
        name: ws.name,
        slug: ws.slug,
        timezone: ws.timezone || "UTC",
        description: ws.description || "",
        logo: ws.logo || null,
        logoUrl: ws.logoUrl || null,
        branding: ws.branding || {},
        notificationPreferences: ws.notificationPreferences || {},
        owner: ws.owner,
        role,
        isOwner,
        memberCount,
        createdAt: ws.createdAt,
        updatedAt: ws.updatedAt,
      };
    });

    res.status(200).json({
      success: true,
      workspaces: result,
      total: result.length,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getWorkspace = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const rawId = req.params.id;
    const id = (Array.isArray(rawId) ? rawId[0] : rawId) || "";
    let workspace: any = null;

    if (mongoose.Types.ObjectId.isValid(id)) {
      workspace = await Workspace.findById(id).lean();
    }
    if (!workspace) {
      workspace = await Workspace.findOne({ slug: id.toLowerCase().trim() }).lean();
    }

    if (!workspace) {
      res.status(404).json({ success: false, message: "Workspace not found" });
      return;
    }

    // Check membership / ownership
    const userId = authReq.user._id;
    const membership = await Membership.findOne({
      userId,
      workspaceId: workspace._id,
    }).lean();

    const isOwner = workspace.owner.toString() === userId.toString();

    if (!membership && !isOwner && authReq.user.role !== "super_admin") {
      res.status(403).json({
        success: false,
        message: "Forbidden: You do not have permission to access this workspace",
        error: {
          code: "FORBIDDEN_WORKSPACE_ACCESS",
          message: "Forbidden: You do not have permission to access this workspace",
        },
      });
      return;
    }

    const memberCount = await Membership.countDocuments({ workspaceId: workspace._id });
    const role = membership?.role || (isOwner ? "owner" : "member");
    const isOwnerFinal = isOwner || role === "owner";

    const workspaceData = {
      _id: workspace._id,
      id: workspace._id.toString(),
      name: workspace.name,
      slug: workspace.slug,
      timezone: workspace.timezone || "UTC",
      description: workspace.description || "",
      logo: workspace.logo || null,
      logoUrl: workspace.logoUrl || null,
      branding: workspace.branding || {},
      notificationPreferences: workspace.notificationPreferences || {},
      owner: workspace.owner,
      role,
      isOwner: isOwnerFinal,
      memberCount: Math.max(memberCount, isOwnerFinal ? 1 : 0),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };

    res.status(200).json({
      success: true,
      workspace: workspaceData,
      data: workspaceData,
      role,
      isOwner: isOwnerFinal,
    });
  } catch (error) {
    next(error);
  }
};

export const updateWorkspace = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const rawId = req.params.id;
    const id = (Array.isArray(rawId) ? rawId[0] : rawId) || "";
    const { name, description, logo, timezone } = req.body;

    let workspace: any = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      workspace = await Workspace.findById(id);
    }
    if (!workspace) {
      workspace = await Workspace.findOne({ slug: id.toLowerCase().trim() });
    }

    if (!workspace) {
      res.status(404).json({ success: false, message: "Workspace not found" });
      return;
    }

    const userId = authReq.user._id;
    const membership = await Membership.findOne({ userId, workspaceId: workspace._id });
    const isOwner = workspace.owner.toString() === userId.toString() || membership?.role === "owner";
    const isAdmin = isOwner || membership?.role === "admin";

    if (!isAdmin && authReq.user.role !== "super_admin") {
      res.status(403).json({ success: false, message: "Forbidden: You do not have permission to update this workspace" });
      return;
    }

    if (name !== undefined) workspace.name = name;
    if (description !== undefined) workspace.description = description;
    if (logo !== undefined) workspace.logo = logo;
    if (timezone !== undefined) workspace.timezone = timezone;

    await workspace.save();

    res.status(200).json({
      success: true,
      message: "Workspace updated successfully",
      workspace,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteWorkspace = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const rawId = req.params.id;
    const id = (Array.isArray(rawId) ? rawId[0] : rawId) || "";
    let workspace: any = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      workspace = await Workspace.findById(id);
    }
    if (!workspace) {
      workspace = await Workspace.findOne({ slug: id.toLowerCase().trim() });
    }

    if (!workspace) {
      res.status(404).json({ success: false, message: "Workspace not found" });
      return;
    }

    const userId = authReq.user._id;
    const membership = await Membership.findOne({ userId, workspaceId: workspace._id });
    const isOwner = workspace.owner.toString() === userId.toString() || membership?.role === "owner";

    if (!isOwner && authReq.user.role !== "super_admin") {
      res.status(403).json({ success: false, message: "Forbidden: You are not the owner of this workspace" });
      return;
    }

    await Membership.deleteMany({ workspaceId: workspace._id });
    await Workspace.findByIdAndDelete(workspace._id);

    res.status(200).json({
      success: true,
      message: "Workspace deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};
