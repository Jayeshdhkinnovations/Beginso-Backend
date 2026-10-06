import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import Notification from "../models/Notification";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { verifyUnsubscribeToken } from "../services/notificationEmail.service";
import { contextOrRespond, RequestContext } from "../utils/contextScope";

const NOTIFICATION_TYPES = ["welcome", "password_reset", "form_activity", "assignment", "mention", "response_edited"];

const format = (n: any) => ({
  id: n._id.toString(),
  type: n.type,
  title: n.title,
  message: n.message,
  read: n.read,
  createdAt: n.createdAt,
});

// The Mongo filter for "this caller, in this context". A workspace context sees only that workspace's
// notifications. The personal context sees notifications with no workspace AND legacy rows whose workspaceId
// no longer points at a workspace (OQ-7: unusable = personal). The caller's own userId is ALWAYS part of the
// filter, so no header value can reach another user's rows.
const contextFilter = async (userId: any, ctx: RequestContext): Promise<Record<string, any>> => {
  if (ctx.kind === "workspace") return { userId, workspaceId: new mongoose.Types.ObjectId(ctx.workspaceId) };
  const referenced: any[] = await Notification.distinct("workspaceId", { userId, workspaceId: { $ne: null } });
  const alive = new Set(
    referenced.length ? (await Workspace.find({ _id: { $in: referenced } }).select("_id").lean()).map((w) => String(w._id)) : []
  );
  const orphaned = referenced.filter((id) => !alive.has(String(id)));
  // `workspaceId: null` also matches a missing field.
  return { userId, $or: [{ workspaceId: null }, { workspaceId: { $in: orphaned } }] };
};

const encodeCursor = (n: any): string => Buffer.from(`${new Date(n.createdAt).getTime()}_${n._id}`).toString("base64url");
const decodeCursor = (raw: string): { at: Date; id: mongoose.Types.ObjectId } | null => {
  try {
    const [ms, id] = Buffer.from(raw, "base64url").toString().split("_");
    if (!/^\d+$/.test(ms) || !mongoose.Types.ObjectId.isValid(id)) return null;
    return { at: new Date(Number(ms)), id: new mongoose.Types.ObjectId(id) };
  } catch {
    return null;
  }
};

/**
 * GET /api/notifications
 * Lists caller's notifications (newest first, max 50).
 */
export const getNotifications = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const q = req.query;
    const hasContextHeader = !!(req.headers["x-workspace-slug"] || req.headers["x-workspace-id"]);
    const hasParams = ["unread", "type", "limit", "cursor"].some((k) => q[k] !== undefined);

    // Legacy call (no context, no params): newest 50 across everything, exactly as before Sprint 14.
    if (!hasContextHeader && !hasParams) {
      const notifications = await Notification.find({ userId: authReq.user._id }).sort({ createdAt: -1 }).limit(50);
      res.status(200).json({ success: true, notifications: notifications.map(format) });
      return;
    }

    const ctx = await contextOrRespond(req, res);
    if (!ctx) return;

    const filter: Record<string, any> = await contextFilter(authReq.user._id, ctx);
    if (q.unread !== undefined && ["1", "true"].includes(String(q.unread).toLowerCase())) filter.read = false;

    if (q.type !== undefined) {
      const types = String(q.type).split(",").map((t) => t.trim()).filter(Boolean);
      if (types.length === 0 || types.some((t) => !NOTIFICATION_TYPES.includes(t))) {
        res.status(400).json({ success: false, message: "Invalid type filter", error: { code: "VALIDATION_ERROR", message: "Invalid type filter" } });
        return;
      }
      filter.type = { $in: types };
    }

    const limit = Math.min(50, Math.max(1, parseInt(String(q.limit ?? ""), 10) || 30));

    if (q.cursor !== undefined) {
      const cur = decodeCursor(String(q.cursor));
      if (!cur) {
        res.status(400).json({ success: false, message: "Invalid cursor", error: { code: "VALIDATION_ERROR", message: "Invalid cursor" } });
        return;
      }
      const before = { $or: [{ createdAt: { $lt: cur.at } }, { createdAt: cur.at, _id: { $lt: cur.id } }] };
      filter.$and = [...(filter.$and || []), before];
    }

    const rows = await Notification.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
    const page = rows.slice(0, limit);
    res.status(200).json({
      success: true,
      notifications: page.map(format),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/notifications/unread-count
 * Unread notifications for the caller in the active context.
 */
export const getUnreadCount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }
    const ctx = await contextOrRespond(req, res);
    if (!ctx) return;
    const count = await Notification.countDocuments({ ...(await contextFilter(authReq.user._id, ctx)), read: false });
    res.status(200).json({ success: true, count });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/notifications/read-all
 * Marks every unread notification the caller has in the active context as read. Idempotent.
 */
export const markAllRead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }
    const ctx = await contextOrRespond(req, res);
    if (!ctx) return;
    const result = await Notification.updateMany({ ...(await contextFilter(authReq.user._id, ctx)), read: false }, { $set: { read: true } });
    res.status(200).json({ success: true, updated: result.modifiedCount });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/notifications/:id/read or PATCH /api/notifications/:id/read
 * Marks a notification as read.
 */
export const markNotificationRead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const { id } = req.params;
    const notification = await Notification.findById(id);

    if (!notification) {
      res.status(404).json({ success: false, message: "Notification not found" });
      return;
    }

    if (notification.userId.toString() !== authReq.user._id.toString()) {
      res.status(403).json({ success: false, message: "Forbidden: Access denied to notification" });
      return;
    }

    notification.read = true;
    await notification.save();

    res.status(200).json({
      success: true,
      message: "Notification marked as read",
      notification: {
        id: notification._id.toString(),
        type: notification.type,
        title: notification.title,
        message: notification.message,
        read: notification.read,
        createdAt: notification.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/public/notifications/unsubscribe/:token   (no session)
 * Sprint 14 (B4.2). The link in every activity email. The token is signed and expires; it names one
 * membership and the only thing it can do is set that membership's email preference to "none".
 * Idempotent. Returns a small HTML page for a browser, JSON for `Accept: application/json`.
 */
export const unsubscribeFromEmails = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = verifyUnsubscribeToken(String(req.params.token ?? ""));
    const wantsJson = (req.headers.accept || "").includes("application/json");
    const reply = (status: number, title: string, message: string, code?: string) => {
      if (wantsJson) {
        res.status(status).json({ success: status < 400, message, ...(code ? { error: { code, message } } : {}) });
      } else {
        res
          .status(status)
          .type("html")
          .send(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>` +
              `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;color:#111827"><h1 style="font-size:20px">${title}</h1><p style="color:#4B5563">${message}</p></body></html>`
          );
      }
    };

    if (!result.ok) {
      if (result.reason === "expired") return reply(410, "Link expired", "This unsubscribe link has expired. Open Beginso and change your email notifications in Settings.", "TOKEN_EXPIRED");
      return reply(400, "Invalid link", "This unsubscribe link is not valid.", "TOKEN_INVALID");
    }
    if (!mongoose.Types.ObjectId.isValid(result.membershipId)) {
      return reply(400, "Invalid link", "This unsubscribe link is not valid.", "TOKEN_INVALID");
    }
    await Membership.updateOne({ _id: result.membershipId }, { $set: { notificationPreference: "none" } });
    reply(200, "You are unsubscribed", "You will no longer get Beginso activity emails for this workspace. You can turn them back on in Settings.");
  } catch (error) {
    next(error);
  }
};
