import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import SessionModel from "../models/Session";

/**
 * GET /api/auth/sessions
 * List all active/historical sessions for the caller.
 * Never exposes raw IP address.
 */
export const getSessions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const userId = authReq.user._id;
    const currentSessionId = authReq.sessionId ? authReq.sessionId.toString() : null;

    const sessions = await SessionModel.find({ userId }).sort({ lastActiveAt: -1 }).limit(100);

    const formattedSessions = sessions.map((s) => {
      const sId = s._id.toString();
      const isCurrent = currentSessionId ? sId === currentSessionId : false;
      return {
        id: sId,
        deviceLabel: s.deviceLabel,
        approxLocation: s.approxLocation && typeof s.approxLocation === "object" && Object.keys(s.approxLocation).length > 0 ? s.approxLocation : {},
        lastActiveAt: s.lastActiveAt,
        createdAt: s.createdAt,
        revokedAt: s.revokedAt || null,
        isCurrent,
      };
    });

    res.status(200).json({
      success: true,
      sessions: formattedSessions,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/auth/sessions/:id
 * Revokes a session by setting revokedAt = Date.now().
 * Strictly scoped to caller's own sessions (403 for another user's session).
 */
export const revokeSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const sessionId = req.params.id as string;
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      res.status(400).json({ success: false, message: "Invalid session ID" });
      return;
    }

    const session = await SessionModel.findById(sessionId);
    if (!session) {
      res.status(404).json({ success: false, message: "Session not found" });
      return;
    }

    if (session.userId.toString() !== authReq.user._id.toString()) {
      res.status(403).json({ success: false, message: "Access denied to session belonging to another user" });
      return;
    }

    session.revokedAt = new Date();
    await session.save();

    res.status(200).json({
      success: true,
      message: "Session revoked successfully",
    });
  } catch (error) {
    next(error);
  }
};
