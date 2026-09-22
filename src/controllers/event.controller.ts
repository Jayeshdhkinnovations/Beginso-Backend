import { Request, Response } from "express";
import { Event } from "../models/Event";
import { Logger } from "../utils/logger";

function mapEventItem(event: any) {
  return {
    id: event._id.toString(),
    workspaceId: event.workspaceId.toString(),
    actor: {
      id: event.actorId ? event.actorId.toString() : "",
      name: event.actorName || event.actorEmail || "Unknown",
      email: event.actorEmail || ""
    },
    action: event.action,
    targetId: event.targetId,
    targetType: event.targetType,
    targetLabel: event.targetLabel,
    metadata: event.metadata || {},
    ip: event.ip || null,
    createdAt: event.createdAt
  };
}

export const listWorkspaceActivity = async (req: Request, res: Response) => {
  try {
    const authReq = req as any;
    const workspaceId = req.params.id || req.params.workspaceId || authReq.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ success: false, message: "Workspace ID is required" });
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const skip = (page - 1) * limit;

    const events = await Event.find({ workspaceId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const mappedEvents = events.map(mapEventItem);

    return res.status(200).json({
      success: true,
      events: mappedEvents,
      page,
      limit
    });
  } catch (error: any) {
    Logger.error("Failed to list workspace activity events", error);
    return res.status(500).json({ success: false, message: "Server error listing workspace activity" });
  }
};

export const listWorkspaceAudit = async (req: Request, res: Response) => {
  try {
    const authReq = req as any;
    const workspaceId = req.params.id || req.params.workspaceId || authReq.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ success: false, message: "Workspace ID is required" });
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const skip = (page - 1) * limit;

    const query: any = { workspaceId };

    if (req.query.actorId) {
      query.actorId = req.query.actorId;
    } else if (req.query.actorEmail) {
      query.actorEmail = { $regex: req.query.actorEmail as string, $options: "i" };
    }

    if (req.query.action) {
      query.action = req.query.action;
    }

    if (req.query.from || req.query.to) {
      query.createdAt = {};
      if (req.query.from) {
        query.createdAt.$gte = new Date(req.query.from as string);
      }
      if (req.query.to) {
        query.createdAt.$lte = new Date(req.query.to as string);
      }
    }

    const events = await Event.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const mappedEvents = events.map(mapEventItem);

    return res.status(200).json({
      success: true,
      events: mappedEvents,
      audit: mappedEvents,
      page,
      limit
    });
  } catch (error: any) {
    Logger.error("Failed to list workspace audit log", error);
    return res.status(500).json({ success: false, message: "Server error listing workspace audit log" });
  }
};

export const listFormEvents = async (req: Request, res: Response) => {
  try {
    const { formId } = req.params;
    if (!formId) {
      return res.status(400).json({ success: false, message: "Form ID is required" });
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const skip = (page - 1) * limit;

    const events = await Event.find({ targetId: formId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const mappedEvents = events.map(mapEventItem);

    return res.status(200).json({
      success: true,
      events: mappedEvents,
      page,
      limit
    });
  } catch (error: any) {
    Logger.error("Failed to list form events", error);
    return res.status(500).json({ success: false, message: "Server error listing form events" });
  }
};
