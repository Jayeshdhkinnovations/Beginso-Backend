// POST /api/auth/forgot-password answers truthfully: only an address that can really get a reset link gets a 202.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { getAuth } from "firebase-admin/auth";
import app from "../app";
import { mailService } from "../services/mail.service";
import * as rateLimiter from "../utils/rateLimiter";

const auth = getAuth() as any;
const realLookup = auth.getUserByEmail;
const realLink = auth.generatePasswordResetLink;
let sent: any[] = [];
const realSend = mailService.sendMail;

const user = (over: Record<string, unknown> = {}) => ({
  uid: "uid-1",
  disabled: false,
  providerData: [{ providerId: "password" }],
  ...over,
});
const post = (email: unknown) => request(app).post("/api/auth/forgot-password").send({ email });
let n = 0;
const fresh = () => `reset${++n}-${Date.now()}@example.com`; // a new address each time keeps the per-email rate limit out of the way

// The per-IP and per-address rate limiters keep their counters in Mongo: without a connection every request would wait out
// mongoose's 10 s buffering timeout (and log "failed open") before being answered.
let mongoServer: MongoMemoryServer;
beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

beforeEach(() => {
  sent = [];
  auth.generatePasswordResetLink = async () => "https://x.firebaseapp.com/__/auth/action?oobCode=abc&apiKey=k";
  (mailService as any).sendMail = async (m: any) => {
    sent.push(m);
  };
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
  auth.getUserByEmail = realLookup;
  auth.generatePasswordResetLink = realLink;
  (mailService as any).sendMail = realSend;
});

describe("forgot password", () => {
  it("404 for an address with no account, and sends nothing", async () => {
    auth.getUserByEmail = async () => {
      throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
    };
    const res = await post(fresh());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ACCOUNT_NOT_FOUND");
    expect(sent).toHaveLength(0);
  });

  it("400 for a malformed address, without asking Firebase", async () => {
    let asked = false;
    auth.getUserByEmail = async () => {
      asked = true;
      return user();
    };
    for (const bad of ["", "nope", "a@b", 42, undefined]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_EMAIL");
    }
    expect(asked).toBe(false);
  });

  it("400 NO_PASSWORD for a Google-only account, and sends nothing", async () => {
    auth.getUserByEmail = async () => user({ providerData: [{ providerId: "google.com" }] });
    const res = await post(fresh());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_PASSWORD");
    expect(sent).toHaveLength(0);
  });

  it("403 for a suspended account, and sends nothing", async () => {
    auth.getUserByEmail = async () => user({ disabled: true });
    const res = await post(fresh());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
    expect(sent).toHaveLength(0);
  });

  it("202 for a real password account, then sends the reset mail to that address", async () => {
    auth.getUserByEmail = async () => user();
    const email = fresh();
    const res = await post(email);
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(email);
    expect(sent[0].actionUrl).toContain("/reset-password?mode=resetPassword&oobCode=abc");
  });

  it("429 when the per-address reset limit says no, and sends nothing", async () => {
    auth.getUserByEmail = async () => user();
    const spy = jest.spyOn(rateLimiter, "checkResetRateLimit").mockResolvedValue(false);
    const res = await post(fresh());
    spy.mockRestore();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(sent).toHaveLength(0);
  });

  it("503 when Firebase itself fails, not a false success", async () => {
    auth.getUserByEmail = async () => {
      throw new Error("network down");
    };
    const res = await post(fresh());
    expect(res.status).toBe(503);
  });
});
