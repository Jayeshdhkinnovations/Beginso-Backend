import { keyedHash } from "./pepper";
import { SystemLog } from "../models/SystemLog";

export function hashIp(ip: string): string {
  if (!ip) return "unknown";
  return keyedHash(ip);
}

export function sanitizeObj(obj: any): any {
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  // Handle Mongoose documents by converting to plain object
  if (typeof obj.toObject === "function") {
    obj = obj.toObject();
  }

  if (obj instanceof Error) {
    return {
      message: obj.message,
      name: obj.name,
      stack: obj.stack,
    };
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObj(item));
  }

  const result: any = {};
  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    const value = obj[key];

    // Redact credentials/tokens/cookies
    if (
      lowerKey.includes("password") ||
      lowerKey.includes("token") ||
      lowerKey.includes("cookie") ||
      lowerKey.includes("jwt") ||
      lowerKey.includes("authorization") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("cookie")
    ) {
      result[key] = "[REDACTED]";
    }
    // Hash IP addresses
    else if (
      lowerKey === "ip" ||
      lowerKey === "rawip" ||
      lowerKey === "clientip" ||
      lowerKey === "ipaddress" ||
      lowerKey === "x-forwarded-for"
    ) {
      if (typeof value === "string") {
        result[key] = hashIp(value);
      } else if (Array.isArray(value)) {
        result[key] = value.map(ipStr => typeof ipStr === "string" ? hashIp(ipStr) : "unknown");
      } else {
        result[key] = "[REDACTED]";
      }
    }
    // Deep sanitize nested objects/arrays
    else if (typeof value === "object" && value !== null) {
      result[key] = sanitizeObj(value);
    }
    // Sanitize string values that might look like raw IPs
    else if (typeof value === "string") {
      const ipv4Pattern = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
      const ipv6Pattern = /^(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}$/i;
      if (ipv4Pattern.test(value) || ipv6Pattern.test(value)) {
        result[key] = hashIp(value);
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

export class Logger {
  static async info(message: string, meta?: any, route?: string, statusCode?: number) {
    console.log(`[INFO] ${message}`, meta ? JSON.stringify(sanitizeObj(meta)) : "");
    try {
      await SystemLog.create({
        level: "info",
        message,
        route,
        statusCode,
        meta: meta ? sanitizeObj(meta) : undefined,
      });
    } catch (err) {
      console.error("Failed to write info log to MongoDB:", err);
    }
  }

  static async warn(message: string, meta?: any, route?: string, statusCode?: number) {
    console.warn(`[WARN] ${message}`, meta ? JSON.stringify(sanitizeObj(meta)) : "");
    try {
      await SystemLog.create({
        level: "warn",
        message,
        route,
        statusCode,
        meta: meta ? sanitizeObj(meta) : undefined,
      });
    } catch (err) {
      console.error("Failed to write warn log to MongoDB:", err);
    }
  }

  static async error(message: string, err?: any, meta?: any, route?: string, statusCode?: number) {
    const errorStack = err instanceof Error ? err.stack : undefined;
    const errorMessage = err instanceof Error ? err.message : String(err || "");
    const combinedMsg = `${message}${errorMessage ? `: ${errorMessage}` : ""}`;

    console.error(`[ERROR] ${combinedMsg}`, errorStack || "");

    try {
      await SystemLog.create({
        level: "error",
        message: combinedMsg,
        route,
        statusCode,
        stack: errorStack,
        meta: meta ? sanitizeObj(meta) : undefined,
      });
    } catch (dbErr) {
      console.error("Failed to write error log to MongoDB:", dbErr);
    }
  }
}
