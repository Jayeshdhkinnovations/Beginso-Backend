import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import SessionModel from "../models/Session";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";

let mongoServer: MongoMemoryServer;
let alice: any;
let bob: any;

const mkSession = (userId: any, deviceLabel: string, extra: Record<string, unknown> = {}) =>
  SessionModel.create({ userId, deviceLabel, userAgent: "Mozilla/5.0", ipHash: "abcdef1234567890", lastActiveAt: new Date(), ...extra });

const tokenFor = (user: any, sessionId?: string) =>
  generateToken({ id: user._id.toString(), email: user.email, role: user.role, ...(sessionId ? { sessionId } : {}) });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  alice = await User.create({ firebaseUid: "uid-a", fullName: "Alice", email: "alice@test.com", role: "admin", status: "active" });
  bob = await User.create({ firebaseUid: "uid-b", fullName: "Bob", email: "bob@test.com", role: "admin", status: "active" });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

beforeEach(async () => {
  await SessionModel.deleteMany({});
});

describe("DELETE /api/auth/sessions (sign out of all other devices)", () => {
  it("revokes the caller's other active sessions, keeps the current one, and reports the count", async () => {
    const current = await mkSession(alice._id, "Chrome on Windows");
    const phone = await mkSession(alice._id, "Safari on iOS");
    const laptop = await mkSession(alice._id, "Firefox on Linux");

    const res = await request(app).delete("/api/auth/sessions").set("Authorization", `Bearer ${tokenFor(alice, current._id.toString())}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, revoked: 2 });
    expect((await SessionModel.findById(current._id))!.revokedAt ?? null).toBeNull();
    expect((await SessionModel.findById(phone._id))!.revokedAt).toBeTruthy();
    expect((await SessionModel.findById(laptop._id))!.revokedAt).toBeTruthy();

    // The kept session still works.
    const still = await request(app).get("/api/auth/sessions").set("Authorization", `Bearer ${tokenFor(alice, current._id.toString())}`);
    expect(still.status).toBe(200);
  });

  it("a revoked session can no longer be used", async () => {
    const current = await mkSession(alice._id, "Chrome on Windows");
    const phone = await mkSession(alice._id, "Safari on iOS");
    await request(app).delete("/api/auth/sessions").set("Authorization", `Bearer ${tokenFor(alice, current._id.toString())}`);

    const res = await request(app).get("/api/auth/sessions").set("Authorization", `Bearer ${tokenFor(alice, phone._id.toString())}`);
    expect(res.status).toBe(401);
  });

  it("never touches another user's sessions", async () => {
    const current = await mkSession(alice._id, "Chrome on Windows");
    const bobs = await mkSession(bob._id, "Chrome on macOS");

    await request(app).delete("/api/auth/sessions").set("Authorization", `Bearer ${tokenFor(alice, current._id.toString())}`);

    expect((await SessionModel.findById(bobs._id))!.revokedAt ?? null).toBeNull();
  });

  it("does not count sessions that were already revoked", async () => {
    const current = await mkSession(alice._id, "Chrome on Windows");
    await mkSession(alice._id, "Old phone", { revokedAt: new Date(Date.now() - 86_400_000) });
    await mkSession(alice._id, "Tablet");

    const res = await request(app).delete("/api/auth/sessions").set("Authorization", `Bearer ${tokenFor(alice, current._id.toString())}`);
    expect(res.body.revoked).toBe(1);
  });

  it("returns 0 when there are no other sessions", async () => {
    const current = await mkSession(alice._id, "Chrome on Windows");
    const res = await request(app).delete("/api/auth/sessions").set("Authorization", `Bearer ${tokenFor(alice, current._id.toString())}`);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(0);
  });

  it("refuses (400) a sign-in that has no session, instead of signing everything out", async () => {
    await mkSession(alice._id, "Tablet");
    const res = await request(app).delete("/api/auth/sessions").set("Authorization", `Bearer ${tokenFor(alice)}`);
    expect(res.status).toBe(400);
    expect(await SessionModel.countDocuments({ userId: alice._id, revokedAt: null })).toBe(1);
  });

  it("requires a signed-in caller (401)", async () => {
    const res = await request(app).delete("/api/auth/sessions");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/users/me theme", () => {
  it("saves and returns the colour theme, and rejects an unknown one", async () => {
    const s = await mkSession(alice._id, "Chrome on Windows");
    const auth = { Authorization: `Bearer ${tokenFor(alice, s._id.toString())}` };

    const ok = await request(app).patch("/api/users/me").set(auth).send({ theme: "dark" });
    expect(ok.status).toBe(200);
    expect(ok.body.user.theme).toBe("dark");
    expect((await request(app).get("/api/users/me").set(auth)).body.user.theme).toBe("dark");

    const bad = await request(app).patch("/api/users/me").set(auth).send({ theme: "purple" });
    expect(bad.status).toBe(400);
  });
});
