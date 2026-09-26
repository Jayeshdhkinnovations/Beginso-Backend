import { Request, Response, NextFunction } from "express";
import { SystemLog } from "../models/SystemLog";
import { getRealClientIp, hashIp } from "../utils/ip";

const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

export const submitRateLimiter = (req: Request, res: Response, next: NextFunction): void => {
  const maxLimit = process.env.RATE_LIMIT_MAX ? parseInt(process.env.RATE_LIMIT_MAX, 10) : 10;
  const windowMs = process.env.RATE_LIMIT_WINDOW_MS ? parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) : 60000; // 1 minute

  if (maxLimit === 0) {
    return next();
  }

  const slug = req.params.slug;
  if (!slug) {
    return next();
  }

  const clientIp = getRealClientIp(req);
  const hashedIp = hashIp(clientIp);
  const key = `${hashedIp}:${slug}`;

  const now = Date.now();
  const record = rateLimitStore.get(key);

  if (!record || now > record.resetTime) {
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + windowMs,
    });
    return next();
  }

  record.count += 1;
  if (record.count > maxLimit) {
    SystemLog.create({
      level: "warn",
      message: "Rate limit exceeded",
      route: req.originalUrl,
      statusCode: 429,
      meta: {
        type: "rate_limit",
        ipHash: hashedIp,
        slug: slug
      }
    }).catch(err => console.error("Error logging rate limit to SystemLog:", err));

    res.status(429).json({
      success: false,
      message: "Too many requests. Please try again later.",
    });
    return;
  }

  next();
};

// Rate limiter for unauthenticated public endpoints (e.g. GET /api/templates/public).
// Per-IP only (no session/slug), defaults to 30 req/min.
const publicRateLimitStore = new Map<string, { count: number; resetTime: number }>();

export const publicTemplatesRateLimiter = (req: Request, res: Response, next: NextFunction): void => {
  const maxLimit = process.env.PUBLIC_RATE_LIMIT_MAX ? parseInt(process.env.PUBLIC_RATE_LIMIT_MAX, 10) : 30;
  const windowMs = process.env.PUBLIC_RATE_LIMIT_WINDOW_MS ? parseInt(process.env.PUBLIC_RATE_LIMIT_WINDOW_MS, 10) : 60000;

  if (maxLimit === 0) {
    return next();
  }

  const clientIp = getRealClientIp(req);
  const hashedIp = hashIp(clientIp);
  const key = `public-templates:${hashedIp}`;

  const now = Date.now();
  const record = publicRateLimitStore.get(key);

  if (!record || now > record.resetTime) {
    publicRateLimitStore.set(key, {
      count: 1,
      resetTime: now + windowMs,
    });
    return next();
  }

  record.count += 1;
  if (record.count > maxLimit) {
    SystemLog.create({
      level: "warn",
      message: "Rate limit exceeded",
      route: req.originalUrl,
      statusCode: 429,
      meta: {
        type: "rate_limit",
        ipHash: hashedIp,
      }
    }).catch(err => console.error("Error logging rate limit to SystemLog:", err));

    res.status(429).json({
      success: false,
      message: "Too many requests. Please try again later.",
    });
    return;
  }

  next();
};

export const clearRateLimitStore = (): void => {
  rateLimitStore.clear();
  publicRateLimitStore.clear();
};
