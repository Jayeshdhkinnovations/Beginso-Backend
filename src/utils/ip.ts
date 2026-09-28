import { Request } from "express";
import { keyedHash } from "./pepper";

/**
 * Extracts the real client IP address from request headers (Cloudflare, Nginx reverse proxy, multi-hop x-forwarded-for, or socket IP).
 */
export const getRealClientIp = (req: Request): string => {
  if (!req) return "unknown";

  // 1. Body payload overrides (when frontend passes clientIp or ip explicitly in request body)
  if (req.body && typeof req.body === "object") {
    if (req.body.clientIp && typeof req.body.clientIp === "string" && req.body.clientIp.trim()) {
      return req.body.clientIp.trim();
    }
    if (req.body.ip && typeof req.body.ip === "string" && req.body.ip.trim()) {
      return req.body.ip.trim();
    }
  }

  // 2. Direct Edge Client Headers (Cloudflare, Akamai, Vercel, Custom Proxy)
  const candidateHeaders = [
    req.headers["x-client-ip"],
    req.headers["x-real-client-ip"],
    req.headers["cf-connecting-ip"],
    req.headers["true-client-ip"],
    req.headers["x-vercel-forwarded-for"],
    req.headers["x-forwarded-client-ip"],
  ];

  for (const h of candidateHeaders) {
    if (h) {
      const raw = Array.isArray(h) ? h[0] : h;
      if (typeof raw === "string" && raw.trim() !== "") {
        const clean = raw.split(",")[0].trim();
        if (clean) return clean;
      }
    }
  }

  // 3. Standard X-Forwarded-For header (the VERY FIRST hop is the original client IP)
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const rawStr = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    if (typeof rawStr === "string" && rawStr.trim() !== "") {
      const firstIp = rawStr.split(",")[0].trim();
      if (firstIp) return firstIp;
    }
  }

  // 4. Fallback: Nginx X-Real-IP (only if X-Forwarded-For is absent)
  const realIp = req.headers["x-real-ip"];
  if (realIp && typeof realIp === "string" && realIp.trim() !== "") {
    return realIp.trim();
  }

  // 5. Express req.ip or socket remoteAddress fallback
  const directIp = req.ip || (req.socket && req.socket.remoteAddress);
  if (directIp && typeof directIp === "string" && directIp.trim() !== "") {
    return directIp.trim();
  }

  return "unknown";
};

/**
 * Computes a keyed (HMAC-SHA-256) hash of IP address for privacy-compliant logging and rate limiting keys.
 */
export const hashIp = (ip: string): string => {
  if (!ip || ip === "unknown") return "unknown";
  return keyedHash(ip.trim());
};
