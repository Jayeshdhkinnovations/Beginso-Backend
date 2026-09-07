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
            uid: `mock-uid-${token}`,
            email: `${token}@test.com`,
            name: `User ${token}`,
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
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;

let userA: any;
let userAToken: string;
let workspaceA: any;

let userB: any;
let userBToken: string;
let workspaceB: any;

let userViewer: any;
let userViewerToken: string;

let userLazy: any;
let userLazyToken: string;

process.env.JWT_SECRET = "test-jwt-secret-key-for-sprint8-contracts-suite-98765";

const makeToken = (user: any) =>
  generateToken({
    id: user._id.toString(),
    email: user.email,
    role: user.role,
  });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Workspace.init();
  await Membership.init();
  await Form.init();
  await ResponseModel.init();

  // Create User A & Workspace A
  userA = await User.create({
    firebaseUid: "uid-user-a-s8",
    fullName: "User A",
    email: "user_a_s8@test.com",
    role: "admin",
    status: "active",
    theme: "system",
  });

  workspaceA = await Workspace.create({
    name: "Workspace Alpha",
    slug: "workspace-alpha-s8",
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

  userAToken = makeToken(userA);

  // Create User B & Workspace B
  userB = await User.create({
    firebaseUid: "uid-user-b-s8",
    fullName: "User B",
    email: "user_b_s8@test.com",
    role: "admin",
    status: "active",
    theme: "light",
  });

  workspaceB = await Workspace.create({
    name: "Workspace Beta",
    slug: "workspace-beta-s8",
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

  userBToken = makeToken(userB);

  // User Viewer: member of Workspace A with viewer role (no forms:create / forms:write)
  userViewer = await User.create({
    firebaseUid: "uid-viewer-s8",
    fullName: "Viewer User",
    email: "viewer_s8@test.com",
    role: "admin",
    status: "active",
    workspaceId: workspaceA._id,
  });

  await Membership.create({
    userId: userViewer._id,
    workspaceId: workspaceA._id,
    role: "viewer",
    notificationPreference: "none",
  });

  userViewerToken = makeToken(userViewer);

  // User Lazy: newly signed-up user with no workspace
  userLazy = await User.create({
    firebaseUid: "uid-lazy-s8",
    fullName: "Lazy User",
    email: "lazy_s8@test.com",
    role: "admin",
    status: "active",
    workspaceId: null,
  });

  userLazyToken = makeToken(userLazy);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Sprint 8 — Phase 0 Backend Contracts [BE]", () => {
  // =========================================================================
  // BE 0.1: Workspace APIs
  // =========================================================================
  describe("BE 0.1 — Complete Workspace APIs (GET /api/workspaces, GET /:id by id & slug)", () => {
    it("GET /api/workspaces returns all workspaces the caller is a member/owner of", async () => {
      const res = await request(app)
        .get("/api/workspaces")
        .set("Authorization", `Bearer ${userAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.workspaces)).toBe(true);
      expect(res.body.workspaces.length).toBe(1);

      const ws = res.body.workspaces[0];
      expect(ws.id).toBe(workspaceA._id.toString());
      expect(ws.name).toBe("Workspace Alpha");
      expect(ws.slug).toBe("workspace-alpha-s8");
      expect(ws.role).toBe("owner");
      expect(ws.isOwner).toBe(true);
      expect(ws.memberCount).toBeGreaterThanOrEqual(1);
    });

    it("GET /api/workspaces isolates workspaces between different users", async () => {
      const resA = await request(app)
        .get("/api/workspaces")
        .set("Authorization", `Bearer ${userAToken}`);

      const resB = await request(app)
        .get("/api/workspaces")
        .set("Authorization", `Bearer ${userBToken}`);

      expect(resA.body.workspaces.map((w: any) => w.id)).toContain(workspaceA._id.toString());
      expect(resA.body.workspaces.map((w: any) => w.id)).not.toContain(workspaceB._id.toString());

      expect(resB.body.workspaces.map((w: any) => w.id)).toContain(workspaceB._id.toString());
      expect(resB.body.workspaces.map((w: any) => w.id)).not.toContain(workspaceA._id.toString());
    });

    it("GET /api/workspaces returns empty array for lazy user with zero workspaces", async () => {
      const res = await request(app)
        .get("/api/workspaces")
        .set("Authorization", `Bearer ${userLazyToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.workspaces).toHaveLength(0);
      expect(res.body.total).toBe(0);
    });

    it("GET /api/workspaces/:id returns workspace detail by ObjectId", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspaceA._id}`)
        .set("Authorization", `Bearer ${userAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.workspace.name).toBe("Workspace Alpha");
      expect(res.body.workspace.slug).toBe("workspace-alpha-s8");
      expect(res.body.workspace.role).toBe("owner");
    });

    it("GET /api/workspaces/:id returns workspace detail by Slug (case-insensitive)", async () => {
      const res = await request(app)
        .get(`/api/workspaces/WORKSPACE-ALPHA-S8`)
        .set("Authorization", `Bearer ${userAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.workspace.name).toBe("Workspace Alpha");
      expect(res.body.workspace.slug).toBe("workspace-alpha-s8");
    });

    it("GET /api/workspaces/:id returns 403 Forbidden for cross-workspace access by ObjectId", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspaceA._id}`)
        .set("Authorization", `Bearer ${userBToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("GET /api/workspaces/:id returns 403 Forbidden for cross-workspace access by Slug", async () => {
      const res = await request(app)
        .get(`/api/workspaces/workspace-alpha-s8`)
        .set("Authorization", `Bearer ${userBToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("GET /api/workspaces/:id returns 404 for non-existent workspace", async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .get(`/api/workspaces/${nonExistentId}`)
        .set("Authorization", `Bearer ${userAToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("POST /api/workspaces creates workspace, assigns owner membership, and enriches response", async () => {
      const res = await request(app)
        .post("/api/workspaces")
        .set("Authorization", `Bearer ${userLazyToken}`)
        .send({
          name: "Lazy Created Workspace",
          timezone: "Europe/London",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.workspace.name).toBe("Lazy Created Workspace");
      expect(res.body.workspace.timezone).toBe("Europe/London");

      // Verify Membership row created
      const m = await Membership.findOne({
        userId: userLazy._id,
        workspaceId: res.body.workspace._id,
      });
      expect(m).not.toBeNull();
      expect(m?.role).toBe("owner");
      expect(m?.notificationPreference).toBe("all");
    });
  });

  // =========================================================================
  // BE 0.2: Zero-Workspace Signup Guarantee (C1.3)
  // =========================================================================
  describe("BE 0.2 — Zero-Workspace Signup Guarantee (C1.3)", () => {
    it("POST /api/auth/session for new user creates 0 Workspace and 0 Membership rows", async () => {
      const freshEmail = `fresh_signup_${Date.now()}@test.com`;
      const freshToken = `token-fresh-${Date.now()}`;

      // Mock verifyIdToken will return this unique user
      const res = await request(app)
        .post("/api/auth/session")
        .send({
          idToken: freshToken,
          deviceLabel: "Test Device",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const createdUser = await User.findOne({ email: `${freshToken}@test.com` });
      expect(createdUser).not.toBeNull();
      expect(createdUser?.workspaceId).toBeFalsy();

      // Guarantee: zero workspace rows created
      const wsCount = await Workspace.countDocuments({ owner: createdUser?._id });
      expect(wsCount).toBe(0);

      // Guarantee: zero membership rows created
      const memCount = await Membership.countDocuments({ userId: createdUser?._id });
      expect(memCount).toBe(0);
    });
  });

  // =========================================================================
  // BE 0.3: Move Form Between Contexts
  // =========================================================================
  describe("BE 0.3 — Move Form Between Contexts (POST /api/forms/:id/move & PATCH /api/forms/:id/move)", () => {
    let movableForm: any;

    beforeEach(async () => {
      movableForm = await Form.create({
        title: "Movable Form",
        description: "Form to test moving across workspaces",
        workspaceId: workspaceA._id,
        status: "published",
        slug: `movable-form-${Date.now()}`,
        publishedSlug: `published-movable-${Date.now()}`,
        publishedAt: new Date(),
        fields: [
          {
            fieldId: "field-1",
            type: "short_text",
            label: "Your Name",
            required: true,
          },
        ],
        pages: [{ id: "page-1", order: 0, title: "Page 1" }],
        branding: { primaryColor: "#3b82f6" },
        settings: { successMessage: "Thank you!" },
      });

      // Add a submission to verify it is preserved
      await ResponseModel.create({
        formId: movableForm._id,
        answers: { "field-1": "Alice" },
        status: "completed",
      });
    });

    it("Moves form from Workspace A to Workspace B by user with forms:write on A and forms:create on B", async () => {
      // Grant User A editor/member role in Workspace B as well
      await Membership.create({
        userId: userA._id,
        workspaceId: workspaceB._id,
        role: "editor",
        notificationPreference: "none",
      });

      const res = await request(app)
        .post(`/api/forms/${movableForm._id}/move`)
        .set("Authorization", `Bearer ${userAToken}`)
        .send({ targetWorkspaceId: workspaceB._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.form.workspaceId.toString()).toBe(workspaceB._id.toString());

      // Integrity guarantee: check that fields, pages, branding, slugs, submissions are intact
      const updated = await Form.findById(movableForm._id);
      expect(updated?.workspaceId?.toString()).toBe(workspaceB._id.toString());
      expect(updated?.title).toBe("Movable Form");
      expect(updated?.fields).toHaveLength(1);
      expect(updated?.fields[0].fieldId).toBe("field-1");
      expect(updated?.publishedSlug).toBe(movableForm.publishedSlug);
      expect(updated?.branding?.primaryColor).toBe("#3b82f6");

      // Verify responses are still intact and queryable
      const responses = await ResponseModel.find({ formId: movableForm._id });
      expect(responses).toHaveLength(1);
      expect(responses[0].answers["field-1"]).toBe("Alice");
    });

    it("PATCH /api/forms/:id/move works identically for frontend ergonomics", async () => {
      // User A is owner of A, let's add User A to B as admin
      await Membership.findOneAndUpdate(
        { userId: userA._id, workspaceId: workspaceB._id },
        { role: "admin" },
        { upsert: true }
      );

      const res = await request(app)
        .patch(`/api/forms/${movableForm._id}/move`)
        .set("Authorization", `Bearer ${userAToken}`)
        .send({ targetWorkspaceId: workspaceB._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.form.workspaceId.toString()).toBe(workspaceB._id.toString());
    });

    it("Moves form to personal context when targetWorkspaceId is null or 'personal' (C1.6)", async () => {
      const res = await request(app)
        .post(`/api/forms/${movableForm._id}/move`)
        .set("Authorization", `Bearer ${userAToken}`)
        .send({ targetWorkspaceId: null });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.form.workspaceId).toBeNull();

      const updated = await Form.findById(movableForm._id);
      expect(updated?.workspaceId).toBeNull();
      expect(updated?.fields).toHaveLength(1);
    });

    it("Rejects move with 403 when caller lacks forms:write on source workspace", async () => {
      // User B attempts to move Form A without permissions on Workspace A
      const res = await request(app)
        .post(`/api/forms/${movableForm._id}/move`)
        .set("Authorization", `Bearer ${userBToken}`)
        .send({ targetWorkspaceId: workspaceB._id.toString() });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Rejects move with 403 when caller lacks forms:create on destination workspace", async () => {
      // User A tries to move to a workspace where User A has NO membership
      const foreignWorkspace = await Workspace.create({
        name: "Foreign Space",
        slug: `foreign-space-${Date.now()}`,
        owner: new mongoose.Types.ObjectId(),
      });

      const res = await request(app)
        .post(`/api/forms/${movableForm._id}/move`)
        .set("Authorization", `Bearer ${userAToken}`)
        .send({ targetWorkspaceId: foreignWorkspace._id.toString() });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Rejects move with 404 when target workspace does not exist", async () => {
      const nonExistentTargetId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .post(`/api/forms/${movableForm._id}/move`)
        .set("Authorization", `Bearer ${userAToken}`)
        .send({ targetWorkspaceId: nonExistentTargetId.toString() });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("PATCH /api/forms/:id with workspaceId in body is rejected with 400", async () => {
      const res = await request(app)
        .patch(`/api/forms/${movableForm._id}`)
        .set("Authorization", `Bearer ${userAToken}`)
        .send({
          title: "Attempted Hijack",
          workspaceId: workspaceB._id.toString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("workspaceId must not be provided in body or params");
    });

    it("PUT /api/forms/:id with workspaceId in body is rejected with 400", async () => {
      const res = await request(app)
        .put(`/api/forms/${movableForm._id}`)
        .set("Authorization", `Bearer ${userAToken}`)
        .send({
          title: "Attempted Hijack",
          workspaceId: workspaceB._id.toString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("workspaceId must not be provided in body or params");
    });
  });

  // =========================================================================
  // BE 0.4: Create-Form Destination Validation
  // =========================================================================
  describe("BE 0.4 — Create-Form Destination Validation on POST /api/forms", () => {
    it("Creates form when valid destinationWorkspaceId is sent and caller has forms:create", async () => {
      const res = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${userAToken}`)
        .send({
          title: "Explicit Destination Form",
          destinationWorkspaceId: workspaceA._id.toString(),
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.workspaceId.toString()).toBe(workspaceA._id.toString());
      expect(res.body.title).toBe("Explicit Destination Form");
    });

    it("Creates form when client sends destination in workspaceId body field and is authorized", async () => {
      const res = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${userAToken}`)
        .send({
          title: "Body workspaceId Destination Form",
          workspaceId: workspaceA._id.toString(),
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.workspaceId.toString()).toBe(workspaceA._id.toString());
    });

    it("Rejects POST /api/forms with 403 when caller targets a foreign workspace they are not member of", async () => {
      const res = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${userBToken}`)
        .send({
          title: "Cross Workspace Attack Form",
          destinationWorkspaceId: workspaceA._id.toString(),
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Rejects POST /api/forms with 403 when caller has viewer role (lacks forms:create)", async () => {
      const res = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${userViewerToken}`)
        .send({
          title: "Viewer Form Attempt",
          destinationWorkspaceId: workspaceA._id.toString(),
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Rejects POST /api/forms with 404 when target destination workspace does not exist", async () => {
      const nonExistentId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${userAToken}`)
        .send({
          title: "Ghost Workspace Form",
          destinationWorkspaceId: nonExistentId.toString(),
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("Creates standalone personal form when caller has no workspace and destination is omitted (C1.6)", async () => {
      // Create user without workspace
      const standaloneUser: any = await User.create({
        firebaseUid: `uid-standalone-${Date.now()}`,
        fullName: "Standalone User",
        email: `standalone_${Date.now()}@test.com`,
        role: "admin",
        status: "active",
        workspaceId: null,
      });
      const standaloneToken = makeToken(standaloneUser);

      const res = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${standaloneToken}`)
        .send({
          title: "Personal Standalone Form",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.workspaceId).toBeNull();
      expect(res.body.createdBy.toString()).toBe(standaloneUser._id.toString());
    });
  });

  // =========================================================================
  // BE 0.5: Scoping & Cross-Workspace Isolation Matrix
  // =========================================================================
  describe("BE 0.5 — Scoping & Cross-Workspace Isolation Matrix", () => {
    let formInA: any;

    beforeAll(async () => {
      formInA = await Form.create({
        title: "Alpha Secret Form",
        workspaceId: workspaceA._id,
        status: "draft",
      });
    });

    it("User B cannot get Form in Workspace A via GET /api/forms/:id", async () => {
      const res = await request(app)
        .get(`/api/forms/${formInA._id}`)
        .set("Authorization", `Bearer ${userBToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("User B cannot move Form in Workspace A to Workspace B", async () => {
      const res = await request(app)
        .post(`/api/forms/${formInA._id}/move`)
        .set("Authorization", `Bearer ${userBToken}`)
        .send({ targetWorkspaceId: workspaceB._id.toString() });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("User B cannot create a form in Workspace A", async () => {
      const res = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${userBToken}`)
        .send({
          title: "Intruder Form",
          destinationWorkspaceId: workspaceA._id.toString(),
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("User B cannot view Workspace A details via GET /api/workspaces/:id (by ID or Slug)", async () => {
      const resById = await request(app)
        .get(`/api/workspaces/${workspaceA._id}`)
        .set("Authorization", `Bearer ${userBToken}`);
      expect(resById.status).toBe(403);

      const resBySlug = await request(app)
        .get(`/api/workspaces/${workspaceA.slug}`)
        .set("Authorization", `Bearer ${userBToken}`);
      expect(resBySlug.status).toBe(403);
    });

    it("User B cannot update Workspace A via PUT /api/workspaces/:id", async () => {
      const res = await request(app)
        .put(`/api/workspaces/${workspaceA._id}`)
        .set("Authorization", `Bearer ${userBToken}`)
        .send({ name: "Hacked Alpha" });

      expect(res.status).toBe(403);
    });

    it("User B cannot delete Workspace A via DELETE /api/workspaces/:id", async () => {
      const res = await request(app)
        .delete(`/api/workspaces/${workspaceA._id}`)
        .set("Authorization", `Bearer ${userBToken}`);

      expect(res.status).toBe(403);
    });
  });
});
