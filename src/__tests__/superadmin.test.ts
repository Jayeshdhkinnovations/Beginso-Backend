import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import { AuditLog } from "../models/AuditLog";
import fs from "fs";
import path from "path";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";
import { SystemLog } from "../models/SystemLog";
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

  // 1. Create a Super Admin
  const superUser = await User.create({
    firebaseUid: "super-uid",
    fullName: "Main Super Admin",
    email: "superadmin@test.com",
    role: "super_admin",
    status: "active",
  });
  superAdminToken = generateToken({ id: superUser._id.toString(), email: superUser.email, role: superUser.role });

  // 2. Create standard Admin Users
  const admin1 = await User.create({
    firebaseUid: "admin1-uid",
    fullName: "John Active",
    email: "john@test.com",
    role: "admin",
    status: "active",
  });
  const ws1 = await Workspace.create({ name: "Workspace Active", owner: admin1._id });
  admin1.workspaceId = ws1._id;
  await admin1.save();
  normalAdminToken = generateToken({ id: admin1._id.toString(), email: admin1.email, role: admin1.role });

  const admin2 = await User.create({
    firebaseUid: "admin2-uid",
    fullName: "Dave Suspended",
    email: "dave@test.com",
    role: "admin",
    status: "suspended",
  });
  const ws2 = await Workspace.create({ name: "Workspace Suspended", owner: admin2._id });
  admin2.workspaceId = ws2._id;
  await admin2.save();

  // 3. Create Forms
  const form1 = await Form.create({
    title: "Form Alpha",
    workspaceId: ws1._id,
    status: "published",
    publishedSlug: "slug-alpha",
  });

  // 4. Create Responses
  await ResponseModel.create({
    formId: form1._id,
    answers: { "some-key": "some-val" },
    createdAt: new Date(),
  });

  // 5. Create Upload (Storage)
  await Upload.create({
    name: "resume.pdf",
    size: 2048,
    type: "application/pdf",
    path: "resume-path.pdf",
    owner: admin1._id,
  });

  // 6. Create SystemLogs representing Abuse
  await SystemLog.create({
    level: "warn",
    message: "Rate limit exceeded",
    meta: {
      type: "rate_limit",
      ipHash: "ip-hash-1-abcdefghij",
      slug: "slug-alpha",
    },
    createdAt: new Date(),
  });

  await SystemLog.create({
    level: "warn",
    message: "Honeypot silent drop triggered",
    meta: {
      type: "honeypot_drop",
      ipHash: "ip-hash-bot-xyz",
      slug: "slug-alpha",
    },
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Super Admin Stats & Abuse Endpoints Integration Tests", () => {
  describe("GET /api/superadmin/stats", () => {
    it("should reject normal admins", async () => {
      const res = await request(app)
        .get("/api/superadmin/stats")
        .set("Authorization", `Bearer ${normalAdminToken}`);
      
      expect(res.status).toBe(403);
    });

    it("should return correct platform health metrics and recent signups", async () => {
      const res = await request(app)
        .get("/api/superadmin/stats")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      
      // Stats checks
      expect(res.body.stats.totalAdmins.active).toBe(1);
      expect(res.body.stats.totalAdmins.suspended).toBe(1);
      expect(res.body.stats.totalWorkspaces).toBe(2);
      expect(res.body.stats.totalForms).toBe(1);
      expect(res.body.stats.publishedForms).toBe(1);
      expect(res.body.stats.totalResponses).toBe(1);
      expect(res.body.stats.totalStorageUsed).toBe(2048);
      expect(res.body.stats.responsesLast24h).toBe(1);

      // Recent Signups checks
      expect(res.body.recentSignups).toBeInstanceOf(Array);
      expect(res.body.recentSignups.length).toBe(2);
      expect(res.body.recentSignups[0].workspaceName).toBe("Workspace Suspended");
      expect(res.body.recentSignups[1].workspaceName).toBe("Workspace Active");
    });
  });

  describe("GET /api/superadmin/abuse", () => {
    it("should reject normal admins", async () => {
      const res = await request(app)
        .get("/api/superadmin/abuse")
        .set("Authorization", `Bearer ${normalAdminToken}`);
      
      expect(res.status).toBe(403);
    });

    it("should return rate-limiting and honeypot stats over the last 7 days", async () => {
      const res = await request(app)
        .get("/api/superadmin/abuse")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(res.body.abuse.honeypotDrops).toBe(1);
      expect(res.body.abuse.topBlockedIps).toHaveLength(1);
      expect(res.body.abuse.topBlockedIps[0].hits).toBe(1);
      // first 16 characters of ip-hash-1-abcdefghij => ip-hash-1-abcdef
      expect(res.body.abuse.topBlockedIps[0].ipHash).toBe("ip-hash-1-abcdef");

      expect(res.body.abuse.topBlockedSlugs).toHaveLength(1);
      expect(res.body.abuse.topBlockedSlugs[0].slug).toBe("slug-alpha");
      expect(res.body.abuse.topBlockedSlugs[0].hits).toBe(1);
    });
  });

  describe("GET /api/superadmin/logs", () => {
    beforeAll(async () => {
      // Clear previous logs
      await SystemLog.deleteMany({});

      // Create test logs
      await SystemLog.create({
        level: "info",
        message: "Server started",
        route: "/api/init",
        statusCode: 200,
        meta: { detail: "info-detail" }
      });

      await SystemLog.create({
        level: "warn",
        message: "High memory warning",
        route: "/api/forms",
        statusCode: 200,
        meta: { usage: "85%" }
      });

      await SystemLog.create({
        level: "error",
        message: "Database connection failed",
        route: "/api/db-test",
        statusCode: 500,
        meta: { connectionString: "mongodb://xyz" },
        stack: "Error: DB timeout\n    at Object.connect (test.ts:1:1)"
      });
    });

    it("should reject normal admins", async () => {
      const res = await request(app)
        .get("/api/superadmin/logs")
        .set("Authorization", `Bearer ${normalAdminToken}`);
      
      expect(res.status).toBe(403);
    });

    it("should return paginated logs sorted by timestamp descending", async () => {
      const res = await request(app)
        .get("/api/superadmin/logs")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.logs).toBeInstanceOf(Array);
      expect(res.body.logs.length).toBe(3);
      
      // Sorted by createdAt descending
      expect(res.body.logs[0].level).toBe("error");
      expect(res.body.logs[1].level).toBe("warn");
      expect(res.body.logs[2].level).toBe("info");

      // Pagination checks
      expect(res.body.pagination.total).toBe(3);
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(20);
      expect(res.body.pagination.pages).toBe(1);
    });

    it("should clamp limit parameter to a maximum of 100", async () => {
      const res = await request(app)
        .get("/api/superadmin/logs?limit=250")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.pagination.limit).toBe(100);
    });

    it("should apply filters correctly (level, route, search)", async () => {
      // 1. Level filter
      let res = await request(app)
        .get("/api/superadmin/logs?level=warn")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(res.body.logs).toHaveLength(1);
      expect(res.body.logs[0].level).toBe("warn");

      // 2. Route filter
      res = await request(app)
        .get("/api/superadmin/logs?route=db-test")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(res.body.logs).toHaveLength(1);
      expect(res.body.logs[0].level).toBe("error");

      // 3. Search filter
      res = await request(app)
        .get("/api/superadmin/logs?search=memory")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(res.body.logs).toHaveLength(1);
      expect(res.body.logs[0].level).toBe("warn");
    });

    it("should include full meta only on error-level logs", async () => {
      const res = await request(app)
        .get("/api/superadmin/logs")
        .set("Authorization", `Bearer ${superAdminToken}`);

      const errorLog = res.body.logs.find((log: any) => log.level === "error");
      const infoLog = res.body.logs.find((log: any) => log.level === "info");

      expect(errorLog.meta).toBeDefined();
      expect(errorLog.meta.connectionString).toBe("mongodb://xyz");

      // Non-error level log metadata should be stripped
      expect(infoLog.meta).toBeUndefined();
    });

    it("should include stack trace in non-production environments", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      
      const res = await request(app)
        .get("/api/superadmin/logs?level=error")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.body.logs[0].stack).toBeDefined();
      expect(res.body.logs[0].stack).toContain("test.ts:1:1");

      process.env.NODE_ENV = originalEnv;
    });

    it("should strip stack trace in production environment", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      const res = await request(app)
        .get("/api/superadmin/logs?level=error")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.body.logs[0].stack).toBeUndefined();

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe("GET /api/superadmin/stats Hourly Trends", () => {
    it("should return 24-hour trends for all 6 metrics", async () => {
      const res = await request(app)
        .get("/api/superadmin/stats")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.trends).toBeDefined();
      const metrics = [
        "users",
        "publishedForms",
        "totalForms",
        "totalResponses",
        "storageUsed",
        "responsesLast24h",
      ];
      for (const m of metrics) {
        expect(res.body.trends[m]).toBeDefined();
        expect(Array.isArray(res.body.trends[m])).toBe(true);
        expect(res.body.trends[m].length).toBe(24);
        expect(res.body.trends[m][0]).toHaveProperty("hour");
        expect(res.body.trends[m][0]).toHaveProperty("count");
      }
    });
  });

  describe("Admin Management CRUD & Cascade Deletion", () => {
    let testAdminId: string;
    const testAdminEmail = "john.cascade@example.com";

    it("should create a new admin and verify workspace bootstrapping", async () => {
      const res = await request(app)
        .post("/api/superadmin/admins")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({
          name: "John Cascade",
          email: testAdminEmail,
          workspaceName: "Cascade Consulting",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.admin).toBeDefined();
      expect(res.body.admin.id).toBeDefined();
      expect(res.body.admin.workspaceId).toBeDefined();

      testAdminId = res.body.admin.id;

      // Verify DB records
      const user = await User.findById(testAdminId);
      expect(user).toBeDefined();
      expect(user?.fullName).toBe("John Cascade");
      expect(user?.role).toBe("admin");
      expect(user?.workspaceId).toBeDefined();

      const ws = await Workspace.findById(user?.workspaceId);
      expect(ws).toBeDefined();
      expect(ws?.name).toBe("Cascade Consulting");
    });

    it("should list admins with correct form/response/storage count telemetry and support search + status filters", async () => {
      // 1. Fetch normal list
      const res = await request(app)
        .get("/api/superadmin/admins")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.admins).toBeDefined();
      expect(Array.isArray(res.body.admins)).toBe(true);

      const target = res.body.admins.find((a: any) => a.id === testAdminId);
      expect(target).toBeDefined();
      expect(target.name).toBe("John Cascade");
      expect(target.email).toBe(testAdminEmail);
      expect(target.workspaceName).toBe("Cascade Consulting");
      expect(target.formCount).toBe(0);
      expect(target.responseCount).toBe(0);
      expect(target.storageUsed).toBe(0);

      // 2. Test search filter (match)
      const resSearchMatch = await request(app)
        .get("/api/superadmin/admins?search=john")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(resSearchMatch.body.admins.some((a: any) => a.id === testAdminId)).toBe(true);

      // 3. Test search filter (no match)
      const resSearchNoMatch = await request(app)
        .get("/api/superadmin/admins?search=xyznonexistent")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(resSearchNoMatch.body.admins.some((a: any) => a.id === testAdminId)).toBe(false);

      // 4. Test status filter (match active)
      const resStatusActive = await request(app)
        .get("/api/superadmin/admins?status=active")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(resStatusActive.body.admins.some((a: any) => a.id === testAdminId)).toBe(true);

      // 5. Test status filter (no match suspended)
      const resStatusSuspended = await request(app)
        .get("/api/superadmin/admins?status=suspended")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(resStatusSuspended.body.admins.some((a: any) => a.id === testAdminId)).toBe(false);
    });

    it("should fetch admin detail with profile, workspace, usage, and loginHistory", async () => {
      const res = await request(app)
        .get(`/api/superadmin/admins/${testAdminId}`)
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.profile).toBeDefined();
      expect(res.body.profile.id).toBe(testAdminId);
      expect(res.body.profile.name).toBe("John Cascade");
      expect(res.body.profile.email).toBe(testAdminEmail);
      expect(res.body.profile.status).toBe("active");
      
      expect(res.body.workspace).toBeDefined();
      expect(res.body.workspace.name).toBe("Cascade Consulting");
      
      expect(res.body.usage).toBeDefined();
      expect(res.body.usage.formCount).toBe(0);
      expect(res.body.usage.responseCount).toBe(0);
      expect(res.body.usage.storageUsed).toBe(0);

      expect(res.body.loginHistory).toBeDefined();
      expect(Array.isArray(res.body.loginHistory)).toBe(true);
      expect(res.body.loginHistory.length).toBe(1);
    });

    it("should reject malformed create requests with 422 and field errors", async () => {
      const res = await request(app)
        .post("/api/superadmin/admins")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({
          name: "Jo", // too short
          email: "not-an-email", // invalid email
          workspaceName: "", // missing
        });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors.some((e: any) => e.field === "name")).toBe(true);
      expect(res.body.errors.some((e: any) => e.field === "email")).toBe(true);
      expect(res.body.errors.some((e: any) => e.field === "workspaceName")).toBe(true);
    });

    it("should reject malformed edit requests with 422 and field errors", async () => {
      const res = await request(app)
        .patch(`/api/superadmin/admins/${testAdminId}`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({
          name: "Jo", // too short
          status: "invalid-status", // bad enum
        });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors.some((e: any) => e.field === "name")).toBe(true);
      expect(res.body.errors.some((e: any) => e.field === "status")).toBe(true);
    });

    it("should update admin name, workspace, and status", async () => {
      const res = await request(app)
        .patch(`/api/superadmin/admins/${testAdminId}`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({
          name: "John Cascade Updated",
          workspaceName: "Cascade Consulting Updated",
          status: "suspended",
        });

      expect(res.status).toBe(200);
      expect(res.body.admin.name).toBe("John Cascade Updated");
      expect(res.body.admin.workspaceName).toBe("Cascade Consulting Updated");
      expect(res.body.admin.status).toBe("suspended");

      const user = await User.findById(testAdminId);
      expect(user?.status).toBe("suspended");
    });

    it("should fail deletion if confirm email does not match", async () => {
      const res = await request(app)
        .delete(`/api/superadmin/admins/${testAdminId}`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({ confirm: "wrong@example.com" });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
    });

    it("should cascade delete user, workspace, forms, responses, upload records, and physical files from disk", async () => {
      const adminDoc = await User.findById(testAdminId);
      const wsId = adminDoc?.workspaceId;

      // Seed child records to delete
      const formDoc = await Form.create({
        title: "Test Form",
        workspaceId: wsId,
        fields: [],
        status: "published",
        slug: "test-cascade-slug",
      });

      await ResponseModel.create({
        formId: formDoc._id,
        answers: {},
      });

      // Create physical mock file on disk
      const dummyDir = path.resolve(__dirname, "../../uploads");
      if (!fs.existsSync(dummyDir)) {
        fs.mkdirSync(dummyDir, { recursive: true });
      }
      const dummyFilePath = path.join(dummyDir, "test-cascade.txt");
      fs.writeFileSync(dummyFilePath, "test cascade physical file content");

      const uploadDoc = await Upload.create({
        name: "test-cascade.txt",
        path: dummyFilePath,
        type: "text/plain",
        size: 100,
        owner: new mongoose.Types.ObjectId(testAdminId),
      });

      // Assert preconditions
      expect(fs.existsSync(dummyFilePath)).toBe(true);

      const res = await request(app)
        .delete(`/api/superadmin/admins/${testAdminId}`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({ confirm: testAdminEmail });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cascadeResult.userDeleted).toBe(true);
      expect(res.body.cascadeResult.workspaceDeleted).toBe(true);
      expect(res.body.cascadeResult.formsDeleted).toBe(1);
      expect(res.body.cascadeResult.responsesDeleted).toBe(1);
      expect(res.body.cascadeResult.filesCleared.successCount).toBe(1);

      // Verify postconditions
      expect(fs.existsSync(dummyFilePath)).toBe(false);

      const userCheck = await User.findById(testAdminId);
      expect(userCheck).toBeNull();

      const wsCheck = await Workspace.findById(wsId);
      expect(wsCheck).toBeNull();

      const formCheck = await Form.findById(formDoc._id);
      expect(formCheck).toBeNull();

      const respCheck = await ResponseModel.findOne({ formId: formDoc._id });
      expect(respCheck).toBeNull();

      const uploadCheck = await Upload.findById(uploadDoc._id);
      expect(uploadCheck).toBeNull();
    });
  });

  describe("Audit Logs & Schema Immutability", () => {
    it("should retrieve paginated audit log entries with filters", async () => {
      const res = await request(app)
        .get("/api/superadmin/audit?action=admin.create")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.auditLogs).toBeDefined();
      expect(Array.isArray(res.body.auditLogs)).toBe(true);
      expect(res.body.auditLogs.length).toBeGreaterThan(0);
      expect(res.body.auditLogs[0].action).toBe("admin.create");
      expect(res.body.auditLogs[0].actorEmail).toBeDefined();
      expect(res.body.auditLogs[0].targetType).toBe("admin");
    });

    it("should prevent updating or deleting audit logs directly (immutability)", async () => {
      const log = await AuditLog.findOne();
      expect(log).toBeDefined();

      if (log) {
        // Attempt update should fail
        log.actorEmail = "hacked@example.com";
        await expect(log.save()).rejects.toThrow();

        // Attempt direct delete should fail
        await expect(AuditLog.deleteOne({ _id: log._id })).rejects.toThrow();
      }
    });
  });
});
