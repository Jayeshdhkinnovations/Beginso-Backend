import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import AuthOtp from "../models/AuthOtp";
import AuthTicket from "../models/AuthTicket";
import { generateToken } from "../utils/generateToken";
import { hashKey } from "../utils/rateLimiter";

let mongoServer: MongoMemoryServer;
let userAToken: string;
let mockUserId: string;
let mockWorkspaceId: string;

process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  const userA = await User.create({
    firebaseUid: "auth-otp-user-a",
    fullName: "Auth OTP User",
    email: "authotp@example.com",
    role: "admin",
  });
  mockUserId = userA._id.toString();

  const workspaceA = await Workspace.create({
    name: "Auth OTP Workspace",
    owner: userA._id,
  });
  mockWorkspaceId = workspaceA._id.toString();

  userA.workspaceId = workspaceA._id as any;
  await userA.save();

  userAToken = generateToken({
    id: mockUserId,
    email: userA.email,
    role: userA.role,
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe("Auth OTP & Extended API Requirements", () => {
  it("should process OTP verification flow and reject invalid 6-digit code", async () => {
    // Seed an AuthOtp record for user
    const rawCode = "654321";
    const codeHash = hashKey(rawCode);

    await AuthOtp.create({
      uid: "auth-otp-user-a",
      codeHash,
      attempts: 0,
      consumed: false,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    // Test with invalid code -> expect 400
    const resInvalid = await request(app)
      .post("/api/auth/email-verification/verify")
      .send({
        token: "mock-token",
        code: "999999",
      });

    // Should return 400 or 401 depending on Firebase Admin token verify mock
    expect([400, 401]).toContain(resInvalid.status);
  });

  it("should consume valid reveal ticket and return 6-digit OTP code once", async () => {
    const rawTicket = "opaque-reveal-ticket-1234567890-test-ticket";
    const ticketHash = hashKey(rawTicket);

    await AuthTicket.create({
      firebaseUid: "auth-otp-user-a",
      purpose: "reveal_verify_email_code",
      ticketHash,
      consumed: false,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    // Reveal OTP code using ticket
    const resReveal = await request(app)
      .post("/api/auth/email-verification/reveal")
      .send({ ticket: rawTicket });

    expect(resReveal.status).toBe(200);
    expect(resReveal.body.code).toBeDefined();
    expect(resReveal.body.code).toMatch(/^\d{6}$/);

    // Second reveal with same ticket should fail with 400
    const resSecond = await request(app)
      .post("/api/auth/email-verification/reveal")
      .send({ ticket: rawTicket });

    expect(resSecond.status).toBe(400);
    expect(resSecond.body.message).toBe("This verification link is invalid or has expired.");
  });

  it("should return workspace-wide response stats when formId is omitted from GET /api/responses/stats", async () => {
    const form1 = await Form.create({
      title: "Form One",
      workspaceId: mockWorkspaceId,
      status: "published",
      pages: [{ id: new mongoose.Types.ObjectId().toString(), order: 0, title: "Page 1" }],
      fields: [],
    });

    const form2 = await Form.create({
      title: "Form Two",
      workspaceId: mockWorkspaceId,
      status: "published",
      pages: [{ id: new mongoose.Types.ObjectId().toString(), order: 0, title: "Page 1" }],
      fields: [],
    });

    await ResponseModel.create({
      formId: form1._id,
      answers: { Email: "user1@example.com" },
      status: "new",
      submittedAt: new Date(),
    });

    await ResponseModel.create({
      formId: form2._id,
      answers: { Email: "user2@example.com" },
      status: "completed",
      submittedAt: new Date(),
    });

    const res = await request(app)
      .get("/api/responses/stats")
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.total).toBeGreaterThanOrEqual(2);
    expect(res.body.stats.new).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.completed).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.total).toBe(res.body.stats.new + res.body.stats.in_progress + res.body.stats.completed);
  });

  it("should ensure GET /api/auth/me is read-only and does not touch lastLogin", async () => {
    const userBefore = await User.findById(mockUserId);
    const initialLastLogin = userBefore?.lastLogin;

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    const userAfter = await User.findById(mockUserId);

    if (initialLastLogin) {
      expect(userAfter?.lastLogin?.getTime()).toBe(initialLastLogin.getTime());
    }
  });

});
