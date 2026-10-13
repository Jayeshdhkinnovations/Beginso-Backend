// The email-verification and password-reset mails have their own cooldowns. They are counted in MongoDB (the same
// store as every other limiter), so they survive a restart and are shared by every server instance.
process.env.JWT_SECRET = "test-jwt-secret-key-for-auth-cooldowns";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { RateLimitBucket } from "../models/RateLimitBucket";
import RespondentLink from "../models/RespondentLink";
import { checkResetRateLimit, checkVerificationRateLimit } from "../utils/rateLimiter";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([RateLimitBucket.init(), RespondentLink.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await RateLimitBucket.deleteMany({});
});

describe("verification code mail", () => {
  it("allows the first send and refuses a second one inside the cooldown", async () => {
    expect(await checkVerificationRateLimit("uid-1")).toBe(true);
    expect(await checkVerificationRateLimit("uid-1")).toBe(false);
  });

  it("counts each user separately", async () => {
    expect(await checkVerificationRateLimit("uid-a")).toBe(true);
    expect(await checkVerificationRateLimit("uid-b")).toBe(true);
  });

  it("keeps its state in MongoDB, hashed (no uid or address stored), so it outlives a restart and is shared between instances", async () => {
    await checkVerificationRateLimit("uid-visible-check");
    const rows = await RateLimitBucket.find({}).lean();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain("uid-visible-check");
  });

  it("lets the request through when the counter store fails (sign-in must never be blocked by it)", async () => {
    const spy = jest.spyOn(RateLimitBucket, "findOneAndUpdate").mockImplementation((() => {
      throw new Error("store down");
    }) as any);
    const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await checkVerificationRateLimit("uid-fail-open")).toBe(true);
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
  });
});

describe("password reset mail", () => {
  it("allows one reset mail per address per cooldown and ignores letter case and spaces in the address", async () => {
    expect(await checkResetRateLimit("Person@Example.com")).toBe(true);
    expect(await checkResetRateLimit("  person@example.com ")).toBe(false);
  });

  it("does not store the address", async () => {
    await checkResetRateLimit("secret.person@example.com");
    expect(JSON.stringify(await RateLimitBucket.find({}).lean())).not.toContain("secret.person");
  });
});

describe("respondent links", () => {
  it("expire by themselves: the collection has a TTL index on expiresAt", async () => {
    const indexes = await RespondentLink.collection.indexes();
    const ttl = indexes.find((i: any) => i.key?.expiresAt === 1 && typeof i.expireAfterSeconds === "number");
    expect(ttl).toBeDefined();
  });
});
