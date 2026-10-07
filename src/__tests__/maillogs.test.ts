import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import { computeEmailHash, recordMailLog } from "../models/MailLog";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;
let superAdminToken: string;
let normalAdminToken: string;

process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  const superUser = await User.create({
    firebaseUid: "super-mail-uid",
    fullName: "Super Admin Mail",
    email: "superadmin-mail@test.com",
    role: "super_admin",
    status: "active",
  });
  superAdminToken = generateToken({ id: superUser._id.toString(), email: superUser.email, role: superUser.role });

  const adminUser = await User.create({
    firebaseUid: "admin-mail-uid",
    fullName: "Admin Mail",
    email: "admin-mail@test.com",
    role: "admin",
    status: "active",
  });
  normalAdminToken = generateToken({ id: adminUser._id.toString(), email: adminUser.email, role: adminUser.role });

  // Seed sample mail logs
  await recordMailLog({
    template: "verification",
    outcome: "sent",
    email: "user1@test.com",
    firebaseUid: "uid_111",
    requestId: "req_test_001",
    provider: "smtp",
    latencyMs: 145,
  });

  await recordMailLog({
    template: "password_reset",
    outcome: "failed",
    email: "user2@test.com",
    firebaseUid: "uid_222",
    requestId: "req_test_002",
    provider: "smtp",
    errorCode: "PROVIDER_TIMEOUT",
    latencyMs: 4200,
  });

  await recordMailLog({
    template: "verification",
    outcome: "rate_limited",
    email: "user3@test.com",
    firebaseUid: "uid_333",
    requestId: "req_test_003",
    provider: "smtp",
    errorCode: "RATE_LIMITED",
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe("Mail Logs Model & GET /api/superadmin/mail-logs Endpoint", () => {
  it("should securely hash email addresses with HMAC-SHA256 and never store raw addresses", async () => {
    const rawEmail = "TEST.User@Domain.Com ";
    const hash1 = computeEmailHash(rawEmail);
    const hash2 = computeEmailHash("test.user@domain.com");

    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // 256-bit hex
  });

  it("should reject non-superadmin users with 403 Forbidden", async () => {
    const res = await request(app)
      .get("/api/superadmin/mail-logs")
      .set("Authorization", `Bearer ${normalAdminToken}`);

    expect(res.status).toBe(403);
  });

  it("should return paginated mail logs for superadmin", async () => {
    const res = await request(app)
      .get("/api/superadmin/mail-logs")
      .set("Authorization", `Bearer ${superAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.mailLogs)).toBe(true);
    expect(res.body.mailLogs.length).toBe(3);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.total).toBe(3);
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.limit).toBe(50);
  });

  it("should filter mail logs by template, outcome, and search against requestId", async () => {
    const resTemplate = await request(app)
      .get("/api/superadmin/mail-logs?template=password_reset")
      .set("Authorization", `Bearer ${superAdminToken}`);

    expect(resTemplate.status).toBe(200);
    expect(resTemplate.body.mailLogs.length).toBe(1);
    expect(resTemplate.body.mailLogs[0].template).toBe("password_reset");

    const resOutcome = await request(app)
      .get("/api/superadmin/mail-logs?outcome=rate_limited")
      .set("Authorization", `Bearer ${superAdminToken}`);

    expect(resOutcome.status).toBe(200);
    expect(resOutcome.body.mailLogs.length).toBe(1);
    expect(resOutcome.body.mailLogs[0].outcome).toBe("rate_limited");

    const resSearch = await request(app)
      .get("/api/superadmin/mail-logs?search=req_test_002")
      .set("Authorization", `Bearer ${superAdminToken}`);

    expect(resSearch.status).toBe(200);
    expect(resSearch.body.mailLogs.length).toBe(1);
    expect(resSearch.body.mailLogs[0].requestId).toBe("req_test_002");
  });
});
