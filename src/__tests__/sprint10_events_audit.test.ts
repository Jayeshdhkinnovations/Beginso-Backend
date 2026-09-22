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
import { Event } from "../models/Event";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;

describe("Sprint 10 — Events, Activity & Audit Log Contracts", () => {
  let ownerUser: any;
  let adminUser: any;
  let memberUser: any;
  let viewerUser: any;

  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;
  let viewerToken: string;

  let workspaceA: any;
  let workspaceB: any;
  let formA: any;

  process.env.JWT_SECRET = "test-jwt-secret-key-for-sprint10-events-audit";

  const makeToken = (user: any) =>
    generateToken({
      id: user._id.toString(),
      email: user.email,
      role: user.role || "user",
    });

  beforeAll(async () => {
    await mongoose.disconnect();
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    await Workspace.init();
    await Membership.init();
    await Form.init();
    await Event.init();

    // 1. Create Users
    ownerUser = await User.create({
      firebaseUid: "uid-event-owner",
      fullName: "Owner User",
      email: "event_owner@example.com",
      status: "active",
    });
    ownerToken = makeToken(ownerUser);

    adminUser = await User.create({
      firebaseUid: "uid-event-admin",
      fullName: "Admin User",
      email: "event_admin@example.com",
      status: "active",
    });
    adminToken = makeToken(adminUser);

    memberUser = await User.create({
      firebaseUid: "uid-event-member",
      fullName: "Member User",
      email: "event_member@example.com",
      status: "active",
    });
    memberToken = makeToken(memberUser);

    viewerUser = await User.create({
      firebaseUid: "uid-event-viewer",
      fullName: "Viewer User",
      email: "event_viewer@example.com",
      status: "active",
    });
    viewerToken = makeToken(viewerUser);

    // 2. Create Workspace A & Memberships
    workspaceA = await Workspace.create({
      name: "Workspace Alpha",
      slug: "workspace-alpha",
      owner: ownerUser._id,
    });

    await Membership.create({ userId: ownerUser._id, workspaceId: workspaceA._id, role: "owner" });
    await Membership.create({ userId: adminUser._id, workspaceId: workspaceA._id, role: "admin" });
    await Membership.create({ userId: memberUser._id, workspaceId: workspaceA._id, role: "member" });
    await Membership.create({ userId: viewerUser._id, workspaceId: workspaceA._id, role: "viewer" });

    // 3. Create Workspace B
    workspaceB = await Workspace.create({
      name: "Workspace Beta",
      slug: "workspace-beta",
      owner: ownerUser._id,
    });
    await Membership.create({ userId: ownerUser._id, workspaceId: workspaceB._id, role: "owner" });

    // 4. Create Form A in Workspace A
    formA = await Form.create({
      title: "Test Event Form",
      description: "Testing events",
      workspaceId: workspaceA._id,
      createdBy: ownerUser._id,
      status: "published",
      fields: [],
    });

    // 5. Create Seed Events
    await Event.create({
      workspaceId: workspaceA._id,
      actorId: ownerUser._id,
      actorEmail: ownerUser.email,
      actorName: ownerUser.fullName,
      action: "form.publish",
      targetId: formA._id.toString(),
      targetType: "form",
      targetLabel: formA.title,
      createdAt: new Date(),
    });

    await Event.create({
      workspaceId: workspaceA._id,
      actorId: adminUser._id,
      actorEmail: adminUser.email,
      actorName: adminUser.fullName,
      action: "member.role_change",
      targetId: memberUser._id.toString(),
      targetType: "member",
      targetLabel: memberUser.email,
      metadata: { newRole: "editor" },
      createdAt: new Date(),
    });

    await Event.create({
      workspaceId: workspaceB._id,
      actorId: ownerUser._id,
      actorEmail: ownerUser.email,
      actorName: ownerUser.fullName,
      action: "form.create",
      targetId: new mongoose.Types.ObjectId().toString(),
      targetType: "form",
      targetLabel: "Beta Form",
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  describe("Event Model Immutability", () => {
    it("should prevent updating existing Event document", async () => {
      const eventDoc = await Event.findOne({ workspaceId: workspaceA._id });
      expect(eventDoc).toBeDefined();

      eventDoc!.targetLabel = "Modified Label";
      await expect(eventDoc!.save()).rejects.toThrow("Cannot update an immutable event log entry");
    });
  });

  describe("GET /api/workspaces/:id/events (Workspace Activity)", () => {
    it("should return workspace activity events for any workspace member", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspaceA._id}/events`)
        .set("Authorization", `Bearer ${memberToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.events)).toBe(true);
      expect(res.body.events.length).toBe(2);
      expect(res.body.events[0]).toHaveProperty("action");
      expect(res.body.events[0]).toHaveProperty("actor");
    });

    it("should isolate events by workspace and not bleed Workspace B events into Workspace A", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspaceA._id}/events`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      const targetLabels = res.body.events.map((e: any) => e.targetLabel);
      expect(targetLabels).not.toContain("Beta Form");
    });

    it("should deny unauthenticated callers with 401", async () => {
      const res = await request(app).get(`/api/workspaces/${workspaceA._id}/events`);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/workspaces/:id/audit (Audit Log)", () => {
    it("should allow workspace owner to access audit log", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspaceA._id}/audit`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.events || res.body.audit)).toBe(true);
    });

    it("should allow workspace admin to access audit log", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspaceA._id}/audit`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should reject member role with 403 on audit log", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspaceA._id}/audit`)
        .set("Authorization", `Bearer ${memberToken}`);

      expect(res.status).toBe(403);
    });

    it("should reject viewer role with 403 on audit log", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspaceA._id}/audit`)
        .set("Authorization", `Bearer ${viewerToken}`);

      expect(res.status).toBe(403);
    });

    it("should support server-side action filtering", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspaceA._id}/audit?action=member.role_change`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.events.length).toBe(1);
      expect(res.body.events[0].action).toBe("member.role_change");
    });
  });

  describe("GET /api/forms/:formId/events (Form Activity)", () => {
    it("should return events for a specific form", async () => {
      const res = await request(app)
        .get(`/api/forms/${formA._id}/events`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.events.length).toBe(1);
      expect(res.body.events[0].targetId).toBe(formA._id.toString());
    });
  });
});
