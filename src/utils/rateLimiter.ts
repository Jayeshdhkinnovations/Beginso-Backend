import { keyedHash } from "./pepper";
import { hit } from "../middleware/rateLimiter";

// Cooldowns for the two mails the auth flow can send on its own: the email-verification code and the password
// reset link. They used to live in two in-process Maps (lost on restart, separate per instance, never pruned);
// they now use the same MongoDB counters as every other limiter (RateLimitBucket, TTL cleanup), so they hold
// across restarts and across PM2 instances. As everywhere else, if the counter store is down the request is let
// through rather than blocking sign-in.

export const hashKey = (key: string): string => {
  return keyedHash(key.toLowerCase().trim());
};

// true = allowed. Two rules: at most one send per `cooldownMs`, and at most `hourlyMax` per hour.
const allow = async (name: string, subject: string, cooldownMs: number, hourlyMax: number): Promise<boolean> => {
  try {
    const key = `${name}:${hashKey(subject)}`;
    // A refused attempt must not use up the hourly allowance, so the hour is only counted once the cooldown passed.
    if ((await hit(`${key}:cooldown`, cooldownMs)) > 1) return false;
    if ((await hit(`${key}:hour`, 60 * 60 * 1000)) > hourlyMax) return false;
    return true;
  } catch (err) {
    console.error(`Cooldown "${name}" failed open:`, err);
    return true;
  }
};

// Verification code mail: 30 s between sends, 5 per hour, per Firebase user.
export const checkVerificationRateLimit = (uid: string): Promise<boolean> => allow("otp-send", uid, 30 * 1000, 5);

// Password reset mail: 60 s between sends, 5 per hour, per email address.
export const checkResetRateLimit = (email: string): Promise<boolean> => allow("reset-mail", email, 60 * 1000, 5);
