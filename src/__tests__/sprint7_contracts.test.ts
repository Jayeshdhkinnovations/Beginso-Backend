// Mock Firebase Admin Authentication offline
jest.mock("firebase-admin/auth", () => {
  return {
    getAuth: () => {
      return {
        createUser: async (data: any) => {
          return { uid: `mock-uid-${data.email}` };
        },
        verifyIdToken: async (token: string) => {
          return {
            uid: "mock-uid-session",
            email: "sessionuser@test.com",
            name: "Session User",
          };
        },
        deleteUser: async () => {
          return {};
        },
      };
    },
  };
});

jest.mock("firebase-admin/app", () => {
  return {
    initializeApp: () => {},
    cert: () => {},
    getApps: () => [],
  };
});

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Invitation from "../models/Invitation";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Report from "../models/Report";
import SessionModel from "../models/Session";
import { generateToken } from "../utils/generateToken";
import { migrateUserTheme } from "../scripts/migrateUserTheme";

let mongoServer: MongoMemoryServer;

let userA: any;
let userAToken: string;
let workspaceA: any;
let formA: any;
let responseA: any;
let reportA: any;
let sessionA: any;

let userB: any;
let userBToken: string;
let workspaceB: any;

process.env.JWT_SECRET = "test-jwt-secret-key-for-sprint7-contracts-suite-12345";

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Workspace.init();
  await Membership.init();

  // Create User A & Workspace A
  userA = await User.create({
    firebaseUid: "uid-user-a",
    fullName: "User A",
    email: "user_a@test.com",
    role: "admin",
    status: "active",
    theme: "system",
  });

  workspaceA = await Workspace.create({
    name: "Workspace Alpha",
    slug: "workspace-alpha",
    timezone: "UTC",
    owner: userA._id,
  });

  userA.workspaceId = workspaceA._id;
  await userA.save();

  await Membership.create({
    userId: userA._id,
    workspaceId: workspaceA._id,
    role: "owner",
    notificationPreference: "all",
    timezoneOverride: null,
  });

  sessionA = await SessionModel.create({
    userId: userA._id,
    deviceLabel: "Chrome on macOS",
    userAgent: "Mozilla/5.0",
    ipHash: "hash-user-a",
    lastActiveAt: new Date(),
  });

  userAToken = generateToken({
    id: userA._id.toString(),
    email: userA.email,
    role: userA.role,
    sessionId: sessionA._id.toString(),
  });

  // Create Form A, Response A, Report A
  formA = await Form.create({
    title: "Form Alpha",
    workspaceId: workspaceA._id,
    fields: [
      { fieldId: "f1", label: "Full Name", type: "short_text", required: true, order: 0 },
      { fieldId: "f2", label: "Option", type: "multiple_choice", options: ["A", "B"], order: 1 },
    ],
    pages: [{ id: "p1", title: "Page 1", order: 0 }],
    status: "draft",
  });

  responseA = await ResponseModel.create({
    formId: formA._id,
    answers: { "Full Name": "Alice Sample" },
    status: "new",
    submittedAt: new Date(),
  });

  reportA = await Report.create({
    workspaceId: workspaceA._id,
    format: "csv",
    status: "completed",
    filters: { formId: formA._id.toString() },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  // Create User B & Workspace B
  userB = await User.create({
    firebaseUid: "uid-user-b",
    fullName: "User B",
    email: "user_b@test.com",
    role: "admin",
    status: "active",
    theme: "system",
  });

  workspaceB = await Workspace.create({
    name: "Workspace Beta",
    slug: "workspace-beta",
    timezone: "America/New_York",
    owner: userB._id,
  });

  userB.workspaceId = workspaceB._id;
  await userB.save();

  await Membership.create({
    userId: userB._id,
    workspaceId: workspaceB._id,
    role: "owner",
    notificationPreference: "all",
    timezoneOverride: null,
  });

  const sessionB = await SessionModel.create({
    userId: userB._id,
    deviceLabel: "Firefox on Windows",
    userAgent: "Mozilla/5.0",
    ipHash: "hash-user-b",
    lastActiveAt: new Date(),
  });

  userBToken = generateToken({
    id: userB._id.toString(),
    email: userB.email,
    role: userB.role,
    sessionId: sessionB._id.toString(),
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Sprint 7 — Phase 0 Backend Contracts [BE]", () => {
  // =========================================================================
  // BE 0.1: Workspace model
  // =========================================================================
  describe("BE 0.1 — Workspace model", () => {
    it("should require name, unique slug, and valid IANA timezone with UTC default", async () => {
      const ws = await Workspace.create({
        name: "Acme Corp",
        slug: "acme-corp",
        owner: userA._id,
      });

      expect(ws.name).toBe("Acme Corp");
      expect(ws.slug).toBe("acme-corp");
      expect(ws.timezone).toBe("UTC"); // defaults to UTC

      // Duplicate slug must be rejected
      await expect(
        Workspace.create({
          name: "Acme Duplicate",
          slug: "acme-corp",
          owner: userB._id,
        })
      ).rejects.toThrow();
    });

    it("should reject invalid IANA timezone string", async () => {
      await expect(
        Workspace.create({
          name: "Invalid Timezone WS",
          slug: "invalid-tz-ws",
          timezone: "Mars/Olympus_Mons",
          owner: userA._id,
        })
      ).rejects.toThrow();
    });

    it("guarantees C1.3 lazy model: no workspace row is created when a user signs up", async () => {
      const newUserEmail = "lazy_signup@test.com";

      const res = await request(app)
        .post("/api/auth/signup")
        .send({
          fullName: "Lazy User",
          email: newUserEmail,
          password: "Password123!",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const createdUser = await User.findOne({ email: newUserEmail });
      expect(createdUser).toBeDefined();

      // Crucial C1.3 guarantee: no workspace created
      const userWorkspaces = await Workspace.find({ owner: createdUser!._id });
      expect(userWorkspaces.length).toBe(0);
      expect(createdUser!.workspaceId).toBeFalsy();
    });

    it("creates workspace and owner membership upon explicit POST /api/workspaces", async () => {
      // Create user without workspace
      const standaloneUser = await User.create({
        firebaseUid: "uid-standalone",
        fullName: "Standalone User",
        email: "standalone@test.com",
        role: "admin",
      });

      const standaloneToken = generateToken({
        id: standaloneUser._id.toString(),
        email: standaloneUser.email,
        role: standaloneUser.role,
      });

      const res = await request(app)
        .post("/api/workspaces")
        .set("Authorization", `Bearer ${standaloneToken}`)
        .send({
          name: "Explicit Workspace",
          slug: "explicit-workspace",
          timezone: "Asia/Kolkata",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.workspace.slug).toBe("explicit-workspace");
      expect(res.body.workspace.timezone).toBe("Asia/Kolkata");

      // Verify owner membership created with notificationPreference: 'all'
      const membership = await Membership.findOne({
        userId: standaloneUser._id,
        workspaceId: res.body.workspace._id,
      });
      expect(membership).toBeDefined();
      expect(membership!.role).toBe("owner");
      expect(membership!.notificationPreference).toBe("all");
    });
  });

  // =========================================================================
  // BE 0.2: Membership model
  // =========================================================================
  describe("BE 0.2 — Membership model", () => {
    it("should enforce columns from creation: notificationPreference ('none' default) and timezoneOverride", async () => {
      const tempUser = await User.create({
        firebaseUid: "uid-temp-mem",
        fullName: "Temp Mem User",
        email: "temp_mem@test.com",
        role: "admin",
      });

      const tempWs = await Workspace.create({
        name: "Temp WS",
        slug: "temp-ws-mem",
        owner: tempUser._id,
      });

      const mem = await Membership.create({
        userId: tempUser._id,
        workspaceId: tempWs._id,
        role: "reviewer",
        // notificationPreference omitted to verify default 'none'
      });

      expect(mem.role).toBe("reviewer");
      expect(mem.notificationPreference).toBe("none");
      expect(mem.timezoneOverride).toBeNull();

      // Update timezoneOverride with valid IANA timezone
      mem.timezoneOverride = "Europe/London";
      await mem.save();
      expect(mem.timezoneOverride).toBe("Europe/London");

      // Unique compound index: same user in same workspace cannot have 2 memberships
      await expect(
        Membership.create({
          userId: tempUser._id,
          workspaceId: tempWs._id,
          role: "editor",
        })
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // BE 0.3: Invitation model
  // =========================================================================
  describe("BE 0.3 — Invitation model", () => {
    it("should create invitation model with workspaceId, email, role, status, token, expiresAt", async () => {
      const inv = await Invitation.create({
        workspaceId: workspaceA._id,
        email: "invitee@example.com",
        role: "editor",
        token: "random-invitation-token-12345",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      expect(inv.workspaceId.toString()).toBe(workspaceA._id.toString());
      expect(inv.email).toBe("invitee@example.com");
      expect(inv.role).toBe("editor");
      expect(inv.status).toBe("pending"); // default
      expect(inv.token).toBe("random-invitation-token-12345");
      expect(inv.expiresAt).toBeInstanceOf(Date);

      // Clean up
      await Invitation.deleteOne({ _id: inv._id });
    });
  });

  // =========================================================================
  // BE 0.4: requirePermission() middleware & route retrofitting
  // =========================================================================
  describe("BE 0.4 — requirePermission() middleware & Cross-Workspace 403 Enforcement", () => {
    describe("Forms routes", () => {
      it("POST /api/forms with cross-workspace x-workspace-id header returns 403", async () => {
        const res = await request(app)
          .post("/api/forms")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString())
          .send({ title: "Attacker Form" });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe("FORBIDDEN_WORKSPACE_ACCESS");
      });

      it("GET /api/forms with cross-workspace x-workspace-id header returns 403", async () => {
        const res = await request(app)
          .get("/api/forms")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString());

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("GET /api/forms/:formId for Form A requested by User B returns 403", async () => {
        const res = await request(app)
          .get(`/api/forms/${formA._id}`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("PUT /api/forms/:formId for Form A requested by User B returns 403", async () => {
        const res = await request(app)
          .put(`/api/forms/${formA._id}`)
          .set("Authorization", `Bearer ${userBToken}`)
          .send({ title: "Hijacked Title" });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("PATCH /api/forms/:formId for Form A requested by User B returns 403", async () => {
        const res = await request(app)
          .patch(`/api/forms/${formA._id}`)
          .set("Authorization", `Bearer ${userBToken}`)
          .send({ title: "Patch Hijack" });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("DELETE /api/forms/:formId for Form A requested by User B returns 403", async () => {
        const res = await request(app)
          .delete(`/api/forms/${formA._id}`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("POST /api/forms/:formId/duplicate for Form A requested by User B returns 403", async () => {
        const res = await request(app)
          .post(`/api/forms/${formA._id}/duplicate`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("POST /api/forms/:formId/publish for Form A requested by User B returns 403", async () => {
        const res = await request(app)
          .post(`/api/forms/${formA._id}/publish`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("POST /api/forms/:formId/close for Form A requested by User B returns 403", async () => {
        const res = await request(app)
          .post(`/api/forms/${formA._id}/close`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("GET /api/forms/:formId/submissions for Form A requested by User B returns 403", async () => {
        const res = await request(app)
          .get(`/api/forms/${formA._id}/submissions`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });
    });

    describe("Responses routes", () => {
      it("GET /api/responses with cross-workspace x-workspace-id header returns 403", async () => {
        const res = await request(app)
          .get("/api/responses")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString());

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("GET /api/responses/stats with cross-workspace x-workspace-id header returns 403", async () => {
        const res = await request(app)
          .get("/api/responses/stats")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString());

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("GET /api/responses/:id for Response A requested by User B returns 403", async () => {
        const res = await request(app)
          .get(`/api/responses/${responseA._id}`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("PATCH /api/responses/:id for Response A requested by User B returns 403", async () => {
        const res = await request(app)
          .patch(`/api/responses/${responseA._id}`)
          .set("Authorization", `Bearer ${userBToken}`)
          .send({ status: "completed" });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("DELETE /api/responses/:id for Response A requested by User B returns 403", async () => {
        const res = await request(app)
          .delete(`/api/responses/${responseA._id}`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });
    });

    describe("Dashboard & Analytics routes", () => {
      it("GET /api/dashboard/analytics with cross-workspace x-workspace-id returns 403", async () => {
        const res = await request(app)
          .get("/api/dashboard/analytics")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString());

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("GET /api/analytics/overview with cross-workspace x-workspace-id returns 403", async () => {
        const res = await request(app)
          .get("/api/analytics/overview")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString());

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("GET /api/analytics/questions with cross-workspace x-workspace-id returns 403", async () => {
        const res = await request(app)
          .get("/api/analytics/questions")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString());

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("GET /api/analytics/trends with cross-workspace x-workspace-id returns 403", async () => {
        const res = await request(app)
          .get("/api/analytics/trends")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString());

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("GET /api/analytics/forms with cross-workspace x-workspace-id returns 403", async () => {
        const res = await request(app)
          .get("/api/analytics/forms")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString());

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });
    });

    describe("Reports routes", () => {
      it("POST /api/reports with cross-workspace x-workspace-id returns 403", async () => {
        const res = await request(app)
          .post("/api/reports")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString())
          .send({ format: "csv" });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("GET /api/reports with cross-workspace x-workspace-id returns 403", async () => {
        const res = await request(app)
          .get("/api/reports")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString());

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("GET /api/reports/:id for Report A requested by User B returns 403", async () => {
        const res = await request(app)
          .get(`/api/reports/${reportA._id}`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });
    });

    describe("Templates & Upload routes", () => {
      it("GET /api/templates with cross-workspace x-workspace-id returns 403", async () => {
        const res = await request(app)
          .get("/api/templates")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString());

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("POST /api/upload with cross-workspace x-workspace-id returns 403", async () => {
        const res = await request(app)
          .post("/api/upload")
          .set("Authorization", `Bearer ${userBToken}`)
          .set("x-workspace-id", workspaceA._id.toString());

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });
    });

    describe("Workspace Settings & Management routes", () => {
      it("GET /api/workspaces/:id for Workspace A requested by User B returns 403", async () => {
        const res = await request(app)
          .get(`/api/workspaces/${workspaceA._id}`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("PUT /api/workspaces/:id for Workspace A requested by User B returns 403", async () => {
        const res = await request(app)
          .put(`/api/workspaces/${workspaceA._id}`)
          .set("Authorization", `Bearer ${userBToken}`)
          .send({ name: "Hacked Workspace" });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("DELETE /api/workspaces/:id for Workspace A requested by User B returns 403", async () => {
        const res = await request(app)
          .delete(`/api/workspaces/${workspaceA._id}`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });
    });

    describe("Sessions routes", () => {
      it("DELETE /api/auth/sessions/:id for Session A requested by User B returns 403", async () => {
        const res = await request(app)
          .delete(`/api/auth/sessions/${sessionA._id}`)
          .set("Authorization", `Bearer ${userBToken}`);

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });
    });
  });

  // =========================================================================
  // BE 0.5: User.theme field
  // =========================================================================
  describe("BE 0.5 — User.theme field", () => {
    it("should default to 'system' and be returned by GET /api/auth/me", async () => {
      const res = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${userAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.theme).toBe("system");
    });

    it("should be readable and updatable via user profile settings (/api/users/me)", async () => {
      const getRes = await request(app)
        .get("/api/users/me")
        .set("Authorization", `Bearer ${userAToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.user.theme).toBe("system");

      // Update to 'dark'
      const patchRes = await request(app)
        .patch("/api/users/me")
        .set("Authorization", `Bearer ${userAToken}`)
        .send({ theme: "dark" });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.user.theme).toBe("dark");

      // Confirm GET /api/auth/me returns updated theme in 1 round-trip
      const meRes = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${userAToken}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.user.theme).toBe("dark");
    });

    it("migration script should update existing users without theme to 'system'", async () => {
      // Create user without theme
      const legacyUser = await User.create({
        firebaseUid: "legacy-uid-theme",
        fullName: "Legacy Theme User",
        email: "legacy_theme@test.com",
        role: "admin",
      });
      // Force remove theme field to simulate pre-migration state
      await User.updateOne({ _id: legacyUser._id }, { $unset: { theme: "" } });

      const count = await migrateUserTheme();
      expect(count).toBeGreaterThanOrEqual(1);

      const refreshed = await User.findById(legacyUser._id);
      expect(refreshed!.theme).toBe("system");
    });
  });

  // =========================================================================
  // BE 0.6: Slug preservation on re-publish
  // =========================================================================
  describe("BE 0.6 — Verify slug preservation on re-publish", () => {
    it("should preserve publishedSlug across re-publishing cycles", async () => {
      // 1. Publish Form Alpha for the first time
      const pubRes1 = await request(app)
        .post(`/api/forms/${formA._id}/publish`)
        .set("Authorization", `Bearer ${userAToken}`);

      expect(pubRes1.status).toBe(200);
      const initialPublishedSlug = pubRes1.body.publishedSlug || pubRes1.body.slug;
      expect(initialPublishedSlug).toBeDefined();
      expect(typeof initialPublishedSlug).toBe("string");

      // 2. Close Form Alpha
      const closeRes = await request(app)
        .post(`/api/forms/${formA._id}/close`)
        .set("Authorization", `Bearer ${userAToken}`);

      expect(closeRes.status).toBe(200);

      // 3. Re-publish Form Alpha
      const pubRes2 = await request(app)
        .post(`/api/forms/${formA._id}/publish`)
        .set("Authorization", `Bearer ${userAToken}`);

      expect(pubRes2.status).toBe(200);
      const secondPublishedSlug = pubRes2.body.publishedSlug || pubRes2.body.slug;

      // MUST strictly preserve the same published slug
      expect(secondPublishedSlug).toBe(initialPublishedSlug);

      // Verify on database record as well
      const updatedForm = await Form.findById(formA._id);
      expect(updatedForm!.publishedSlug).toBe(initialPublishedSlug);
    });
  });
});
