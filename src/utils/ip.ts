import { Request } from "express";
import crypto from "crypto";
import { keyedHash } from "./pepper";

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * The client IP that limits and logs are keyed on.
 *
 * Only two sources are believed: (1) `x-client-ip`, but ONLY when the request also carries the
 * shared secret in `x-proxy-secret` (the frontend's own proxy adds both, since from the backend it
 * would otherwise look like every visitor is the proxy); (2) Express's `req.ip`, which honours as
 * many proxy hops as TRUST_PROXY_HOPS says (see app.ts). Body fields and other client-supplied
 * headers are never trusted: anyone can send them.
 */
export const getRealClientIp = (req: Request): string => {
  if (!req) return "unknown";

  const secret = process.env.PROXY_SHARED_SECRET;
  const provided = req.headers?.["x-proxy-secret"];
  if (secret && typeof provided === "string" && safeEqual(provided, secret)) {
    const forwarded = req.headers["x-client-ip"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof raw === "string" && raw.trim()) return raw.split(",")[0].trim();
  }

  const direct = req.ip || req.socket?.remoteAddress;
  return typeof direct === "string" && direct.trim() ? direct.trim() : "unknown";
};

/**
 * Computes a keyed (HMAC-SHA-256) hash of IP address for privacy-compliant logging and rate limiting keys.
 */
export const hashIp = (ip: string): string => {
  if (!ip || ip === "unknown") return "unknown";
  return keyedHash(ip.trim());
};
