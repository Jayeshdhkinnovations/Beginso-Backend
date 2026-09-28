// S-19: rate limits that hold across processes, cannot be dodged by forging an IP, and cover the
// unauthenticated and email-sending endpoints.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import Form from "../models/Form";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { RateLimitBucket } from "../models/RateLimitBucket";
import { clearRateLimitStore } from "../middleware/rateLimiter";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-rate-limit-suite";

let mongoServer: MongoMemoryServer;
let slug: string;

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Form, User, Workspace, Membership, RateLimitBucket].map((m: any) => m.init()));
});

beforeEach(async () => {
  await clearRateLimitStore();
  await Form.deleteMany({});
  delete process.env.PROXY_SHARED_SECRET;
  process.env.RATE_LIMIT_MAX = "2";
  process.env.RATE_LIMIT_WINDOW_MS = "60000";
  slug = `rl-form-${Date.now()}`;
  await Form.create({
    title: "RL",
    status: "published",
    slug,
    publishedSlug: slug,
    fields: [{ fieldId: "f1", label: "Email", type: "short_text", required: false }],
  });
});

afterEach(() => {
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_MS;
  delete process.env.PROXY_SHARED_SECRET;
  delete process.env.AUTH_RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_ALLOWLIST;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const submit = (headers: Record<string, string> = {}, body: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/public/${slug}/submit`)
    .set(headers)
    .field("data", JSON.stringify({ answers: [], ...body }));

describe("public submit limit cannot be dodged by forging an IP", () => {
  it("rotating x-client-ip, cf-connecting-ip, x-real-ip or a body ip does not reset the bucket", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await submit(
        { "x-real-ip": `10.0.0.${i}`, "x-client-ip": `10.1.0.${i}`, "cf-connecting-ip": `10.2.0.${i}` },
        { clientIp: `10.3.0.${i}`, ip: `10.4.0.${i}` }
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(2)).toEqual([429, 429]);
    expect(statuses.slice(0, 2)).not.toContain(429);
  });

  it("with the proxy secret, x-client-ip separates real visitors; with a wrong secret it is ignored", async () => {
    process.env.PROXY_SHARED_SECRET = "proxy-secret-for-test";
    const good = (ip: string) => ({ "x-proxy-secret": "proxy-secret-for-test", "x-client-ip": ip });
    for (let i = 0; i < 5; i++) {
      expect((await submit(good(`203.0.113.${i}`))).status).not.toBe(429);
    }
    const wrong = (ip: string) => ({ "x-proxy-secret": "guess", "x-client-ip": ip });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await submit(wrong(`198.51.100.${i}`))).status);
    expect(statuses.slice(2)).toEqual([429, 429]);
  });

  it("the 429 carries Retry-After and a machine-readable code", async () => {
    await submit();
    await submit();
    const res = await submit();
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("the counter lives in MongoDB", () => {
  it("is shared by anything reading the same collection and cleaned by clearRateLimitStore", async () => {
    await submit();
    expect(await RateLimitBucket.countDocuments({})).toBeGreaterThan(0);
    await clearRateLimitStore();
    expect(await RateLimitBucket.countDocuments({})).toBe(0);
  });

  it("fails open when the store is unavailable", async () => {
    const spy = jest.spyOn(RateLimitBucket, "findOneAndUpdate").mockImplementation((() => {
      throw new Error("db down");
    }) as any);
    const res = await submit();
    spy.mockRestore();
    expect(res.status).not.toBe(429);
    expect(res.status).toBeLessThan(500);
  });

  it("RATE_LIMIT_MAX=0 disables the limiter", async () => {
    process.env.RATE_LIMIT_MAX = "0";
    for (let i = 0; i < 4; i++) expect((await submit()).status).not.toBe(429);
  });
});

describe("unauthenticated auth endpoints", () => {
  it("per IP: the auth limiter stops a flood of session attempts", async () => {
    process.env.AUTH_RATE_LIMIT_MAX = "3";
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(app).post("/api/auth/session").send({ token: "bad" })).status);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  it("per target email: 5 reset/notify emails an hour to one address, from any number of IPs", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push(
        (await request(app).post("/api/auth/password-changed").set("x-forwarded-for", `9.9.9.${i}`).send({ email: "victim@rl.test" })).status
      );
    }
    expect(codes.slice(5)).toEqual([429, 429]);
    expect(codes.slice(0, 5)).not.toContain(429);
    const other = await request(app).post("/api/auth/password-changed").send({ email: "someone-else@rl.test" });
    expect(other.status).not.toBe(429);
  });
});

describe("signed-in actions", () => {
  it("invitations are limited per user", async () => {
    process.env.USER_RATE_LIMIT_MAX = "2";
    const u: any = await User.create({ firebaseUid: "uid-rl", fullName: "rl", email: "rl@rl.test", role: "admin", status: "active" });
    const ws: any = await Workspace.create({ name: "RL", slug: "rl-ws", timezone: "UTC", owner: u._id });
    await Membership.create({ userId: u._id, workspaceId: ws._id, role: "owner" });
    const token = generateToken({ id: u._id.toString(), email: u.email, role: u.role });
    const send = (i: number) =>
      request(app).post(`/api/workspaces/${ws._id}/invitations`).set("Authorization", `Bearer ${token}`).send({ email: `n${i}@rl.test`, role: "viewer" });
    const codes = [(await send(1)).status, (await send(2)).status, (await send(3)).status];
    delete process.env.USER_RATE_LIMIT_MAX;
    expect(codes[2]).toBe(429);
    expect(codes.slice(0, 2)).not.toContain(429);
  });
});

describe("RATE_LIMIT_ALLOWLIST", () => {
  it("an allowlisted IP is never limited, and a forged header cannot claim to be that IP", async () => {
    process.env.PROXY_SHARED_SECRET = "allow-secret";
    process.env.RATE_LIMIT_ALLOWLIST = "203.0.113.77";
    const viaProxy = (ip: string) => submit({ "x-proxy-secret": "allow-secret", "x-client-ip": ip });
    for (let i = 0; i < 6; i++) expect((await viaProxy("203.0.113.77")).status).not.toBe(429);
    const other = [];
    for (let i = 0; i < 4; i++) other.push((await viaProxy("203.0.113.78")).status);
    expect(other.slice(2)).toEqual([429, 429]);
    // no secret: x-client-ip is ignored, so naming the allowlisted IP changes nothing
    await clearRateLimitStore();
    const forged = [];
    for (let i = 0; i < 4; i++) forged.push((await submit({ "x-client-ip": "203.0.113.77" })).status);
    delete process.env.RATE_LIMIT_ALLOWLIST;
    expect(forged.slice(2)).toEqual([429, 429]);
  });
});
