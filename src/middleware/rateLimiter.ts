import { Request, Response, NextFunction } from "express";
import { SystemLog } from "../models/SystemLog";
import { RateLimitBucket } from "../models/RateLimitBucket";
import { getRealClientIp, hashIp } from "../utils/ip";
import { keyedHash } from "../utils/pepper";

// Fixed-window limiter backed by MongoDB (see RateLimitBucket), keyed by a hash so no address or
// email is stored. `max: 0` (or a non-numeric env value) disables a limiter, for tests and local work.
type Limit = { max: number; windowMs: number };

interface LimiterOptions {
  name: string;
  limit: () => Limit;
  // What the limit is counted per. Return null to skip limiting (nothing to key on).
  by: (req: Request, ip: string) => string | null;
  message?: string;
  log?: boolean;
}

const intEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// IPs that are never rate limited (an office or test machine): RATE_LIMIT_ALLOWLIST=1.2.3.4,5.6.7.8
// The address is the one getRealClientIp trusts, so it cannot be claimed with a forged header.
const isAllowlisted = (ip: string): boolean => {
  const list = (process.env.RATE_LIMIT_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 && list.includes(ip.replace(/^::ffff:/, ""));
};

const hit = async (key: string, windowMs: number): Promise<number> => {
  const windowStart = Math.floor(Date.now() / windowMs);
  const bucketKey = `${key}:${windowStart}`;
  const expiresAt = new Date((windowStart + 2) * windowMs);
  const attempt = () =>
    RateLimitBucket.findOneAndUpdate(
      { key: bucketKey },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, new: true }
    ).lean();
  try {
    return (await attempt())!.count;
  } catch (err: any) {
    if (err?.code !== 11000) throw err; // two first hits raced on the upsert: count again
    return (await attempt())!.count;
  }
};

export const createRateLimiter = (options: LimiterOptions) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { max, windowMs } = options.limit();
      if (max === 0) return next();

      const ip = getRealClientIp(req);
      if (isAllowlisted(ip)) return next();
      const subject = options.by(req, ip);
      if (!subject) return next();

      const count = await hit(`${options.name}:${keyedHash(subject)}`, windowMs);
      if (count <= max) return next();

      if (options.log) {
        SystemLog.create({
          level: "warn",
          message: "Rate limit exceeded",
          route: req.originalUrl,
          statusCode: 429,
          meta: { type: "rate_limit", ipHash: hashIp(ip), slug: req.params?.slug },
        }).catch((err) => console.error("Error logging rate limit to SystemLog:", err));
      }
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      res.status(429).json({
        success: false,
        message: options.message ?? "Too many requests. Please try again later.",
        error: { code: "RATE_LIMITED", message: options.message ?? "Too many requests. Please try again later." },
      });
    } catch (err) {
      // A limiter must never take the endpoint down with it: if the counter store is unavailable, let the request through.
      console.error(`Rate limiter "${options.name}" failed open:`, err);
      next();
    }
  };

// ---- Limiters ---------------------------------------------------------------------------------

// POST /api/public/:slug/submit: per IP and form. RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS, default 10/min.
export const submitRateLimiter = createRateLimiter({
  name: "public-submit",
  limit: () => ({ max: intEnv("RATE_LIMIT_MAX", 10), windowMs: intEnv("RATE_LIMIT_WINDOW_MS", 60000) || 60000 }),
  by: (req, ip) => (req.params.slug ? `${ip}:${req.params.slug}` : null),
  log: true,
});

// GET /api/public/:slug (form schema): per IP, generous because every page view calls it.
export const publicFormReadLimiter = createRateLimiter({
  name: "public-read",
  limit: () => ({ max: intEnv("PUBLIC_READ_RATE_LIMIT_MAX", 120), windowMs: 60000 }),
  by: (_req, ip) => ip,
});

// GET /api/templates/public: per IP. PUBLIC_RATE_LIMIT_MAX / PUBLIC_RATE_LIMIT_WINDOW_MS, default 30/min.
export const publicTemplatesRateLimiter = createRateLimiter({
  name: "public-templates",
  limit: () => ({ max: intEnv("PUBLIC_RATE_LIMIT_MAX", 30), windowMs: intEnv("PUBLIC_RATE_LIMIT_WINDOW_MS", 60000) || 60000 }),
  by: (_req, ip) => ip,
  log: true,
});

// Unauthenticated auth endpoints (session, OTP, reset, password-changed): per IP.
export const authRateLimiter = createRateLimiter({
  name: "auth",
  limit: () => ({ max: intEnv("AUTH_RATE_LIMIT_MAX", 30), windowMs: 60000 }),
  by: (_req, ip) => ip,
  log: true,
});

// Endpoints that send an email to an address taken from the request body: also per target address,
// so one caller cannot flood somebody's inbox from many IPs, or a spoofed one.
export const emailTargetRateLimiter = createRateLimiter({
  name: "email-target",
  limit: () => ({ max: intEnv("EMAIL_TARGET_RATE_LIMIT_MAX", 5), windowMs: 60 * 60 * 1000 }),
  by: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    return email || null;
  },
  message: "Too many emails were requested for this address. Please try again later.",
});

// Signed-in actions that are expensive or send mail: per user.
export const userActionRateLimiter = (name: string, max: number, windowMs = 60 * 60 * 1000) =>
  createRateLimiter({
    name: `user-${name}`,
    limit: () => ({ max: intEnv("USER_RATE_LIMIT_MAX", max), windowMs }),
    by: (req, ip) => (req as any).user?._id?.toString() ?? ip,
  });

// Sprint 13 (A5.4). Signed-link endpoints, per IP and per link, so one address cannot hammer a single token
// and one token cannot be probed from many addresses cheaply. Keyed on a hash of the token (never the token).
export const respondLinkRateLimiter = createRateLimiter({
  name: "respond-link",
  limit: () => ({ max: intEnv("RESPOND_LINK_RATE_LIMIT_MAX", 60), windowMs: 60000 }),
  by: (req, ip) => `${ip}:${String(req.params.token ?? "").slice(0, 64)}`,
  log: true,
});

// "Send me a new link": per IP. (The per-address cap is emailTargetRateLimiter.)
export const respondResendRateLimiter = createRateLimiter({
  name: "respond-resend",
  limit: () => ({ max: intEnv("RESPOND_RESEND_RATE_LIMIT_MAX", 10), windowMs: 60 * 60 * 1000 }),
  by: (_req, ip) => ip,
  log: true,
});

export const clearRateLimitStore = async (): Promise<void> => {
  await RateLimitBucket.deleteMany({});
};
