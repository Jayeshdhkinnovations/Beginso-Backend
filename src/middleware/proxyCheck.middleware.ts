import { Request, Response, NextFunction } from "express";
import { isIP } from "net";
import { isPrivateOrInvalidIp } from "../services/geolocation.service";

const plain = (ip: string) => ip.replace(/^::ffff:/i, "").trim();

/**
 * Says, once, that TRUST_PROXY_HOPS is too low. A proxy in front passes the visitor's address in X-Forwarded-For; when that
 * address is public but the one this app settled on is private, the app is taking the proxy for the visitor: no response gets
 * a place on the map, and every visitor shares one rate limit. Nothing else changes, and no address is trusted because of it.
 */
export const proxyCheck = (warn: (message: string) => void = console.warn) => {
  let said = false;
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!said) {
      const forwarded = plain(String(req.headers["x-forwarded-for"] ?? "").split(",")[0]);
      const seen = plain(req.ip ?? "");
      if (isIP(forwarded) && !isPrivateOrInvalidIp(forwarded) && seen && isPrivateOrInvalidIp(seen)) {
        said = true;
        warn(
          `⚠️ TRUST_PROXY_HOPS is too low: a proxy passes on visitors' addresses, but every visitor looks like ${seen}. ` +
            "Responses get no map location and visitors share one rate limit. Set TRUST_PROXY_HOPS to the number of proxies in front of this app."
        );
      }
    }
    next();
  };
};
