import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import User, { IUser } from "../models/User";

import SessionModel from "../models/Session";

export interface AuthenticatedRequest extends Request {
  user?: IUser;
  sessionId?: string;
}

export const protect = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  let token: string | undefined;

  // 1. Check Authorization Header (case-insensitive)
  const authHeader = req.headers.authorization || (req.headers as any).Authorization;
  if (authHeader && typeof authHeader === "string") {
    const parts = authHeader.trim().split(" ");
    if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
      token = parts[1];
    } else if (parts.length === 1) {
      token = parts[0];
    }
  }

  // 2. Check Cookies (if token/jwt/access_token cookie exists)
  if (!token && req.headers.cookie) {
    const cookies = req.headers.cookie.split(";").reduce((acc, c) => {
      const [name, ...val] = c.trim().split("=");
      acc[name] = val.join("=");
      return acc;
    }, {} as Record<string, string>);
    token = cookies.token || cookies.jwt || cookies.access_token;
  }

  if (!token || token === "undefined" || token === "null") {
    res.status(401).json({
      success: false,
      message: "Not authorized, no token provided",
      error: { message: "Not authorized, no token provided" }
    });
    return;
  }

  try {
    // Verify token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET as string
    ) as { id: string; email: string; role: string; sessionId?: string };

    // Session Revocation Enforcement (closing the stateless logout gap)
    if (decoded.sessionId) {
      const session = await SessionModel.findById(decoded.sessionId);
      if (!session || session.revokedAt) {
        res.status(401).json({
          success: false,
          message: "Session has been revoked or expired",
          error: { message: "Session has been revoked or expired" }
        });
        return;
      }
      // Touch lastActiveAt at most once a minute instead of writing on every request.
      if (!session.lastActiveAt || Date.now() - session.lastActiveAt.getTime() > 60_000) {
        session.lastActiveAt = new Date();
        await session.save();
      }
      req.sessionId = decoded.sessionId;
    }

    // Get user from database
    const user = await User.findById(decoded.id).populate("workspaceId");

    if (!user) {
      res.status(401).json({
        success: false,
        message: "Not authorized, user not found",
        error: { message: "Not authorized, user not found" }
      });
      return;
    }

    // Attach user to request
    req.user = user;
    next();
  } catch (error) {
    console.error("JWT Verification Error:", error);
    res.status(401).json({
      success: false,
      message: "Not authorized, token failed",
      error: { message: "Not authorized, token failed" }
    });
  }
};

export const requireSuperAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  const user = req.user;
  if (!user || user.role !== "super_admin") {
    res.status(403).json({
      success: false,
      message: "Access Denied: Super Admin credentials required.",
      error: { code: "FORBIDDEN_SUPER_ADMIN_REQUIRED", message: "FORBIDDEN_SUPER_ADMIN_REQUIRED" }
    });
    return;
  }
  next();
};

export const blockSuspended = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  const user = req.user;

  // Exempt super_admin
  if (user && user.role === "super_admin") {
    return next();
  }

  // Exempt /api/superadmin/*
  if (req.originalUrl && req.originalUrl.startsWith("/api/superadmin")) {
    return next();
  }

  if (user && user.status === "suspended") {
    res.status(403).json({
      success: false,
      message: "Your account has been suspended. Please contact support.",
      error: { code: "ACCOUNT_SUSPENDED", message: "ACCOUNT_SUSPENDED" }
    });
    return;
  }
  next();
};

