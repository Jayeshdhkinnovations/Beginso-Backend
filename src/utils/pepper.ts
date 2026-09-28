import crypto from "crypto";

// Keyed hash for anything derived from personal data (IPs, emails). The key is AUTH_EMAIL_HASH_PEPPER,
// else JWT_SECRET (server.ts refuses to start without it). There is deliberately no hardcoded key.
const key = (): string => process.env.AUTH_EMAIL_HASH_PEPPER || process.env.JWT_SECRET || "test-only-pepper";

export const keyedHash = (value: string): string =>
  crypto.createHmac("sha256", key()).update(value).digest("hex");
