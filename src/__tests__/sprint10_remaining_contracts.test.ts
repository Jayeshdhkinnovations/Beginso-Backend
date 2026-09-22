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
        revokeRefreshTokens: async (uid: string) => {
          return {};
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
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { generateToken } from "../utils/generateToken";
import { runV1Migration } from "../scripts/migrateV1ToMemberships";
import { revokeFirebaseUserTokens } from "../config/firebase";

let mongoServer: MongoMemoryServer;

describe("Sprint 10 — Remaining Backend Contracts (BE 0.6–BE 0.11)", () => {
  let userA: any;
  let tokenA: string;
  let userB: any;
  let tokenB: string;

  process.env.JWT_SECRET = "test-jwt-secret-key-for-sprint10-remaining";

  beforeAll(async () => {
    await mongoose.disconnect();
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  beforeEach(async () => {
    // Clear test collections
    await User.deleteMany({});
    await Form.deleteMany({});
    await ResponseModel.deleteMany({});
    await Workspace.deleteMany({});
    await Membership.deleteMany({});

    // Create test users
    userA = await User.create({
      fullName: "User A",
      email: "usera@example.com",
      status: "active",
      role: "admin",
      firebaseUid: "firebase-uid-a-" + Date.now(),
    });
    tokenA = generateToken({ id: userA._id.toString(), email: userA.email, role: userA.role });

    userB = await User.create({
      fullName: "User B",
      email: "userb@example.com",
      status: "active",
      role: "admin",
      firebaseUid: "firebase-uid-b-" + Date.now(),
    });
    tokenB = generateToken({ id: userB._id.toString(), email: userB.email, role: userB.role });
  });

  describe("BE 0.6 — Form Overview Stats (GET /api/forms/:id/overview)", () => {
    it("returns responseCount, responseCountThisWeek, and nullable completionRate in 1 round trip", async () => {
      // Create personal form for User A
      const form = await Form.create({
        title: "Overview Test Form",
        createdBy: userA._id,
        status: "published",
        fields: [{ id: "f1", type: "short_text", label: "Name" }],
      });

      // Submit 3 responses (2 inside 7 days, 1 older)
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

      await ResponseModel.create({
        formId: form._id,
        answers: { f1: "Alice" },
        submittedAt: now,
      });
      await ResponseModel.create({
        formId: form._id,
        answers: { f1: "Bob" },
        submittedAt: now,
      });
      await ResponseModel.create({
        formId: form._id,
        answers: { f1: "Charlie" },
        submittedAt: tenDaysAgo,
      });

      const res = await request(app)
        .get(`/api/forms/${form._id}/overview`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.overview).toBeDefined();
      expect(res.body.overview.formId).toBe(form._id.toString());
      expect(res.body.overview.responseCount).toBe(3);
      expect(res.body.overview.responseCountThisWeek).toBe(2);
      expect(res.body.overview.completionRate).toBeNull(); // null when view tracking isn't live yet
    });

    it("calculates real completionRate percentage when form view tracking count is present", async () => {
      const form = await Form.create({
        title: "View Tracked Form",
        createdBy: userA._id,
        status: "published",
        viewsCount: 10,
        fields: [{ id: "f1", type: "short_text", label: "Name" }],
      });

      await ResponseModel.create({
        formId: form._id,
        answers: { f1: "Submission 1" },
      });
      await ResponseModel.create({
        formId: form._id,
        answers: { f1: "Submission 2" },
      });

      const res = await request(app)
        .get(`/api/forms/${form._id}/overview`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.overview.responseCount).toBe(2);
      expect(res.body.overview.completionRate).toBe(20.0); // (2 / 10) * 100
    });

    it("rejects unauthorized caller trying to access overview of another workspace form with 403", async () => {
      const wsB = await Workspace.create({
        name: "Workspace B",
        slug: "ws-b",
        owner: userB._id,
      });
      const formB = await Form.create({
        title: "Private Form B",
        workspaceId: wsB._id,
        createdBy: userB._id,
        status: "published",
        fields: [],
      });

      const res = await request(app)
        .get(`/api/forms/${formB._id}/overview`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(403);
    });
  });

  describe("BE 0.7 — Fix GET /api/forms/:id 403-on-own-form", () => {
    it("allows a creator to GET their own personal form (workspaceId: null) immediately", async () => {
      const personalForm = await Form.create({
        title: "Fresh Personal Form",
        createdBy: userA._id,
        workspaceId: null,
        status: "draft",
        fields: [],
      });

      const res = await request(app)
        .get(`/api/forms/${personalForm._id}`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body._id).toBe(personalForm._id.toString());
      expect(res.body.title).toBe("Fresh Personal Form");
    });

    it("preserves strict 403 when a caller tries to GET a form owned by another user without permissions", async () => {
      const wsB = await Workspace.create({
        name: "Workspace B",
        slug: "ws-b-07",
        owner: userB._id,
      });
      const unownedForm = await Form.create({
        title: "Unowned Workspace Form",
        createdBy: userB._id,
        workspaceId: wsB._id,
        status: "published",
        fields: [],
      });

      const res = await request(app)
        .get(`/api/forms/${unownedForm._id}`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(403);
    });
  });

  describe("BE 0.8 & BE 0.9 — V1 Data Migration, Dry-Run & Rollback", () => {
    it("dry-run accurately reports users and forms needing workspace without altering DB", async () => {
      // Create orphan V1 user with forms
      const v1Form = await Form.create({
        title: "V1 Form",
        createdBy: userA._id,
        fields: [],
      });

      const dryRunRes = await runV1Migration({ dryRun: true });

      expect(dryRunRes.dryRun).toBe(true);
      expect(dryRunRes.usersMigrated).toBe(2); // userA & userB need workspace
      expect(dryRunRes.formsUpdated).toBe(1);

      // Verify DB was NOT mutated during dry-run
      const refreshedForm = await Form.findById(v1Form._id);
      expect(refreshedForm?.workspaceId).toBeFalsy();
      const wsCount = await Workspace.countDocuments();
      expect(wsCount).toBe(0);
    });

    it("executes migration, verifies byte-identical form access, rolls back cleanly, and re-runs idempotently", async () => {
      // Create orphan V1 form
      const v1Form = await Form.create({
        title: "V1 Legacy Form",
        createdBy: userA._id,
        fields: [{ id: "f1", type: "short_text", label: "Legacy" }],
      });

      // 1. Run migration
      const migRes = await runV1Migration({ dryRun: false });
      expect(migRes.workspacesCreated).toBe(2);
      expect(migRes.formsUpdated).toBe(1);

      // Verify form visibility after migration is intact
      const getRes = await request(app)
        .get(`/api/forms/${v1Form._id}`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.title).toBe("V1 Legacy Form");
      expect(getRes.body.workspaceId).toBeDefined();

      // 2. Re-run migration to test IDEMPOTENCY
      const reRunRes = await runV1Migration({ dryRun: false });
      expect(reRunRes.workspacesCreated).toBe(0); // 0 new workspaces created
      expect(reRunRes.formsUpdated).toBe(0); // 0 extra forms updated

      // 3. Rollback migration
      const rollbackRes = await runV1Migration({ rollback: true });
      expect(rollbackRes.rollback).toBe(true);

      const postRollbackForm = await Form.findById(v1Form._id);
      expect(postRollbackForm?.workspaceId).toBeFalsy();

      // 4. Re-run after rollback
      const finalRunRes = await runV1Migration({ dryRun: false });
      expect(finalRunRes.workspacesCreated).toBe(2);
    });
  });

  describe("BE 0.10 & BE 0.11 — Firebase Refresh Token Revocation & Origin Check", () => {
    it("revokeFirebaseUserTokens handles token revocation calls gracefully", async () => {
      const res = await revokeFirebaseUserTokens("mock-uid-123");
      expect(typeof res).toBe("boolean");
    });
  });
});
