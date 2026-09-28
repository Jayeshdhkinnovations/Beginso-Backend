import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import SessionModel from "../models/Session";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;
let user1Token: string;
let user1SessionId: string;
let user2Token: string;
let user2SessionId: string;
let user1: any;
let user2: any;
let workspace1: any;

process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  // User 1
  user1 = await User.create({
    firebaseUid: "uid-user-1",
    fullName: "Alice Dev",
    email: "alice@test.com",
    role: "admin",
    status: "active",
  });
  workspace1 = await Workspace.create({
    name: "Alice's Workspace",
    owner: user1._id,
  });
  user1.workspaceId = workspace1._id;
  await user1.save();

  const session1 = await SessionModel.create({
    userId: user1._id,
    deviceLabel: "Chrome on macOS",
    userAgent: "Mozilla/5.0 Chrome/120.0",
    ipHash: "abcdef1234567890",
    lastActiveAt: new Date(),
  });
  user1SessionId = session1._id.toString();
  user1Token = generateToken({
    id: user1._id.toString(),
    email: user1.email,
    role: user1.role,
    sessionId: user1SessionId,
  });

  // User 2
  user2 = await User.create({
    firebaseUid: "uid-user-2",
    fullName: "Bob Dev",
    email: "bob@test.com",
    role: "admin",
    status: "active",
  });
  const workspace2 = await Workspace.create({
    name: "Bob's Workspace",
    owner: user2._id,
  });
  user2.workspaceId = workspace2._id;
  await user2.save();

  const session2 = await SessionModel.create({
    userId: user2._id,
    deviceLabel: "Safari on iOS",
    userAgent: "Mozilla/5.0 Safari/605.1",
    ipHash: "1234567890abcdef",
    lastActiveAt: new Date(),
  });
  user2SessionId = session2._id.toString();
  user2Token = generateToken({
    id: user2._id.toString(),
    email: user2.email,
    role: user2.role,
    sessionId: user2SessionId,
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe("Session Management & Revocation Enforcement", () => {
  it("GET /api/auth/sessions - should list active sessions for caller", async () => {
    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", `Bearer ${user1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBe(1);
    expect(res.body.sessions[0].deviceLabel).toBe("Chrome on macOS");
    expect(res.body.sessions[0].isCurrent).toBe(true);
  });

  it("DELETE /api/auth/sessions/:id - should reject revocation of another user's session (403)", async () => {
    const res = await request(app)
      .delete(`/api/auth/sessions/${user2SessionId}`)
      .set("Authorization", `Bearer ${user1Token}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("DELETE /api/auth/sessions/:id & Protect Middleware - should revoke session and reject subsequent requests", async () => {
    // Revoke user2 session by user2
    const revokeRes = await request(app)
      .delete(`/api/auth/sessions/${user2SessionId}`)
      .set("Authorization", `Bearer ${user2Token}`);

    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.success).toBe(true);

    // Verify subsequent protect request fails with 401
    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", `Bearer ${user2Token}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toContain("revoked");
  });

  it("Protect Middleware - should gracefully degrade for legacy JWTs without sessionId", async () => {
    const legacyToken = generateToken({
      id: user1._id.toString(),
      email: user1.email,
      role: user1.role,
    });

    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${legacyToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe("User Profile (/api/users/me)", () => {
  it("GET /api/users/me - should return user profile details", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${user1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.email).toBe("alice@test.com");
    expect(res.body.user.name).toBe("Alice Dev");
  });

  it("PATCH /api/users/me - should update avatarUrl and name", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${user1Token}`)
      .send({
        name: "Alice Updated",
        avatarUrl: "https://example.com/avatar.png",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.name).toBe("Alice Updated");
    expect(res.body.user.avatarUrl).toBe("https://example.com/avatar.png");
  });

  it("PATCH /api/users/me - should reject email modification (400)", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${user1Token}`)
      .send({
        email: "newemail@test.com",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe("Workspace Settings (/api/workspaces/current)", () => {
  it("GET /api/workspaces/current - should return current workspace settings", async () => {
    const res = await request(app)
      .get("/api/workspaces/current")
      .set("Authorization", `Bearer ${user1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.workspace.name).toBe("Alice's Workspace");
    expect(res.body.workspace.notificationPreferences.newResponseEmail).toBe(true);
  });

  it("PATCH /api/workspaces/current - should update branding and notificationPreferences", async () => {
    const res = await request(app)
      .patch("/api/workspaces/current")
      .set("Authorization", `Bearer ${user1Token}`)
      .send({
        name: "Alice Acme Corp",
        notificationPreferences: {
          newResponseEmail: true,
          weeklyDigestEmail: false,
          productUpdatesEmail: true,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.workspace.name).toBe("Alice Acme Corp");
    expect(res.body.workspace.notificationPreferences.weeklyDigestEmail).toBe(false);
    expect(res.body.workspace.notificationPreferences.productUpdatesEmail).toBe(true);
  });

  it("DELETE /api/workspaces/current - should cascade delete workspace, forms, responses, uploads, and sessions", async () => {
    // Create form & response under workspace1
    const form = await Form.create({
      title: "Cascade Test Form",
      workspaceId: workspace1._id,
      status: "published",
      publishedSlug: "cascade-slug",
      fields: [],
    });
    await ResponseModel.create({
      formId: form._id,
      status: "completed",
      answers: {},
    });

    const delRes = await request(app)
      .delete("/api/workspaces/current")
      .set("Authorization", `Bearer ${user1Token}`)
      .send({ reauthToken: "reauth-uid-user-1" });

    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);

    // Verify zero orphans left
    const remainingForms = await Form.countDocuments({ workspaceId: workspace1._id });
    const remainingResponses = await ResponseModel.countDocuments({ formId: form._id });
    const remainingSessions = await SessionModel.countDocuments({ userId: user1._id });

    expect(remainingForms).toBe(0);
    expect(remainingResponses).toBe(0);
    expect(remainingSessions).toBe(0);
  });
});
