import { Request, Response } from "express";
import mongoose from "mongoose";
import { Event } from "../models/Event";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import User from "../models/User";
import { Logger } from "../utils/logger";
import { assertVerifiedWorkspace } from "../utils/requestContext";

async function resolveWorkspaceObjectId(rawId: string): Promise<string | null> {
  if (!rawId) return null;
  const str = String(rawId).trim();
  if (mongoose.Types.ObjectId.isValid(str)) {
    return str;
  }
  const ws = await Workspace.findOne({ slug: str }).select("_id").lean();
  return ws ? ws._id.toString() : null;
}

// The profile pictures of the people behind a page of events, in one query. The feeds show an avatar next to each actor, and the
// members list that would otherwise supply it is admin-only while Activity is open to every member. Only the picture is read, and
// an actor with no account (an unauthenticated actor) or no picture simply has none.
async function actorAvatars(events: any[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(events.map((e) => (e.actorId ? String(e.actorId) : "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  if (ids.length === 0) return new Map();
  const users = await User.find({ _id: { $in: ids } }).select("avatarUrl").lean();
  return new Map(users.map((u: any) => [String(u._id), u.avatarUrl || null]));
}

async function mapEvents(events: any[]) {
  const avatars = await actorAvatars(events);
  return events.map((e) => mapEventItem(e, avatars));
}

function mapEventItem(event: any, avatars?: Map<string, string | null>) {
  const actorId = event.actorId ? event.actorId.toString() : "";
  return {
    id: event._id.toString(),
    workspaceId: event.workspaceId.toString(),
    actor: {
      id: actorId,
      name: event.actorName || event.actorEmail || "Unknown",
      email: event.actorEmail || "",
      avatarUrl: (actorId && avatars?.get(actorId)) || null
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
    const rawWsId = req.params.id || req.params.workspaceId || authReq.workspaceId;
    if (!rawWsId) {
      return res.status(400).json({ success: false, message: "Workspace ID is required" });
    }

    const workspaceId = await resolveWorkspaceObjectId(rawWsId);
    if (!workspaceId) {
      return res.status(404).json({ success: false, message: "Workspace not found" });
    }
    if (!assertVerifiedWorkspace(req, res, workspaceId)) return;

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const skip = (page - 1) * limit;

    const events = await Event.find({ workspaceId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const mappedEvents = await mapEvents(events);

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
    const rawWsId = req.params.id || req.params.workspaceId || authReq.workspaceId;
    if (!rawWsId) {
      return res.status(400).json({ success: false, message: "Workspace ID is required" });
    }

    const workspaceId = await resolveWorkspaceObjectId(rawWsId);
    if (!workspaceId) {
      return res.status(404).json({ success: false, message: "Workspace not found" });
    }
    if (!assertVerifiedWorkspace(req, res, workspaceId)) return;

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const skip = (page - 1) * limit;

    const query: any = { workspaceId };

    // Filters come straight from the query string, so each is checked before it reaches Mongo. A malformed value used
    // to fail inside the query ("Cast to ObjectId failed" / "Cast to date failed") as a logged 500 (QA A16-010). A
    // repeated filter (?action=a&action=b) arrives as an array and is refused for the same reason.
    const bad = (message: string) => res.status(400).json({ success: false, message, error: { code: "INVALID_FILTER", message } });
    const one = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
    for (const key of ["actorId", "actorEmail", "action", "from", "to"] as const) {
      const v = req.query[key];
      if (v !== undefined && typeof v !== "string") return bad(`${key} must be a single value`);
    }

    const actorId = one(req.query.actorId);
    const actorEmail = one(req.query.actorEmail);
    if (actorId) {
      if (!/^[0-9a-fA-F]{24}$/.test(actorId)) return bad("actorId must be a valid id");
      query.actorId = actorId;
    } else if (actorEmail) {
      query.actorEmail = { $regex: actorEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    }

    const action = one(req.query.action);
    if (action) query.action = action;

    const from = one(req.query.from);
    const to = one(req.query.to);
    if (from || to) {
      query.createdAt = {};
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) return bad("from must be a valid date");
        query.createdAt.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) return bad("to must be a valid date");
        query.createdAt.$lte = d;
      }
    }

    const events = await Event.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const mappedEvents = await mapEvents(events);

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
    const authReq = req as any;
    const { formId } = req.params;
    if (!formId || !mongoose.Types.ObjectId.isValid(String(formId))) {
      return res.status(400).json({ success: false, message: "Form ID is required" });
    }

    const form = await Form.findById(String(formId)).select("workspaceId createdBy").lean();
    if (!form) {
      return res.status(404).json({ success: false, message: "Form not found" });
    }
    if (form.workspaceId) {
      if (!assertVerifiedWorkspace(req, res, form.workspaceId)) return;
    } else if (
      authReq.user?.role !== "super_admin" &&
      !authReq.formAccessGrant &&
      form.createdBy?.toString() !== authReq.user?._id?.toString()
    ) {
      return res.status(403).json({ success: false, message: "Forbidden: You do not have access to this form" });
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const skip = (page - 1) * limit;

    const events = await Event.find({ targetId: formId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const mappedEvents = await mapEvents(events);

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
