import { keyedHash } from "./pepper";

interface RateLimitRecord {
  lastSentAt: number;
  hourlyCount: number;
  hourStart: number;
}

const verificationLimits = new Map<string, RateLimitRecord>();
const resetLimits = new Map<string, RateLimitRecord>();

const PEPPER = process.env.AUTH_EMAIL_HASH_PEPPER || "beginso-auth-pepper-secret-key";

export const hashKey = (key: string): string => {
  return keyedHash(key.toLowerCase().trim());
};

export const checkVerificationRateLimit = (uid: string): boolean => {
  const now = Date.now();
  const record = verificationLimits.get(uid);

  if (!record) {
    verificationLimits.set(uid, { lastSentAt: now, hourlyCount: 1, hourStart: now });
    return true;
  }

  // Check 30s cooldown
  if (now - record.lastSentAt < 30 * 1000) {
    return false;
  }

  // Check 1 hour window
  if (now - record.hourStart > 3600 * 1000) {
    record.hourStart = now;
    record.hourlyCount = 1;
    record.lastSentAt = now;
    return true;
  }

  if (record.hourlyCount >= 5) {
    return false;
  }

  record.hourlyCount += 1;
  record.lastSentAt = now;
  return true;
};

export const checkResetRateLimit = (email: string): boolean => {
  const now = Date.now();
  const key = hashKey(email);
  const record = resetLimits.get(key);

  if (!record) {
    resetLimits.set(key, { lastSentAt: now, hourlyCount: 1, hourStart: now });
    return true;
  }

  // Check 60s cooldown
  if (now - record.lastSentAt < 60 * 1000) {
    return false;
  }

  // Check 1 hour window
  if (now - record.hourStart > 3600 * 1000) {
    record.hourStart = now;
    record.hourlyCount = 1;
    record.lastSentAt = now;
    return true;
  }

  if (record.hourlyCount >= 5) {
    return false;
  }

  record.hourlyCount += 1;
  record.lastSentAt = now;
  return true;
};
