// Mock Firebase Admin Authentication offline
jest.mock("firebase-admin/auth", () => {
  return {
    getAuth: () => {
      return {
        createUser: async (data: any) => {
          return { uid: `mock-uid-${data.email}` };
        },
        verifyIdToken: async (token: string) => {
          if (token === "invalid-token") {
            throw new Error("Invalid Firebase token.");
          }
          if (token === "google-token") {
            return {
              uid: "google-uid-123",
              email: "googleuser@test.com",
              name: "Google User",
            };
          }
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

// Configure testing variables
process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import jwt from "jsonwebtoken";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  // Disconnect standard connections first
  await mongoose.disconnect();

  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
}, 900000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

describe("Onboarding Platform Integration Tests", () => {
  
  // ==========================================
  // SIGNUP API TESTS (3 Cases)
  // ==========================================
  
  describe("Signup API", () => {
    it("Successful signup, C1.3 lazy workspace provisioning, and JWT return", async () => {
      const signupData = {
        fullName: "Jayesh Chaudhary",
        email: "jayesh@test.com",
        password: "Password123!",
      };
      
      const res = await request(app)
        .post("/api/auth/signup")
        .send(signupData);
        
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.headers["set-cookie"]).toBeDefined();
      expect(res.headers["set-cookie"][0]).toContain("token=");
      expect(res.body.token).toBeDefined();
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(signupData.email);
      // Under C1.3 lazy workspace model, no workspace row is created at signup
      expect(res.body.user.workspaceId).toBeFalsy();
      const count = await Workspace.countDocuments({ owner: res.body.user._id });
      expect(count).toBe(0);

      // Workspace is only created when user explicitly creates one
      const wsRes = await request(app)
        .post("/api/workspaces")
        .set("Authorization", `Bearer ${res.body.token}`)
        .send({ name: "Jayesh's Workspace", slug: "jayesh-workspace" });
      expect(wsRes.status).toBe(201);
      expect(wsRes.body.workspace).toBeDefined();
      expect(wsRes.body.workspace._id).toBeDefined();

      // Validate workspace exists and points to user
      const workspace = await Workspace.findById(wsRes.body.workspace._id);
      expect(workspace).toBeDefined();
      expect(workspace!.owner.toString()).toBe(res.body.user._id);
    });

    it("Catch malformed passwords (Zod checks)", async () => {
      const signupData = {
        fullName: "Jayesh Chaudhary",
        email: "jayesh@test.com",
        password: "weak",
      };
      
      const res = await request(app)
        .post("/api/auth/signup")
        .send(signupData);
        
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.errors).toBeDefined();
    });

    it("Catch email duplicates", async () => {
      await User.create({
        firebaseUid: "firebase-existing-123",
        fullName: "Existing User",
        email: "existing@test.com",
      });

      const signupData = {
        fullName: "Another User",
        email: "existing@test.com",
        password: "Password123!",
      };
      
      const res = await request(app)
        .post("/api/auth/signup")
        .send(signupData);
        
      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("already exists");
    });
  });

  // ==========================================
  // LOGIN API TESTS (1 Case)
  // ==========================================

  describe("Login API", () => {
    it("Verify Firebase login exchange & customized JWT issuance", async () => {
      const res = await request(app)
        .post("/api/auth/session")
        .send({ token: "session-token", name: "Session User" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.headers["set-cookie"]).toBeDefined();
      expect(res.headers["set-cookie"][0]).toContain("token=");
      expect(res.body.token).toBeDefined();
      expect(res.body.isNewUser).toBe(true);
      expect(res.body.user.email).toBe("sessionuser@test.com");
    });
  });

  // ==========================================
  // GOOGLE SIGN-IN TESTS (2 Cases)
  // ==========================================

  describe("Google Sign-In API", () => {
    it("Verify login/registration via Firebase Google Auth token", async () => {
      const res = await request(app)
        .post("/api/auth/session")
        .send({ token: "google-token", name: "Google User" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.isNewUser).toBe(true);
      expect(res.body.user.email).toBe("googleuser@test.com");
    });

    it("Reject missing Firebase session token", async () => {
      const res = await request(app)
        .post("/api/auth/session")
        .send({ name: "No Token" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain("Token is required");
    });
  });

  // ==========================================
  // LOGOUT API TESTS (1 Case)
  // ==========================================

  describe("Logout API", () => {
    it("Logout endpoint token clearance response", async () => {
      const user = await User.create({
        firebaseUid: "logout-uid",
        fullName: "Logout User",
        email: "logout@test.com",
      });

      const token = jwt.sign(
        { id: user._id.toString(), email: user.email, role: user.role },
        process.env.JWT_SECRET!
      );

      const res = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.headers["set-cookie"]).toBeDefined();
      expect(res.headers["set-cookie"][0]).toContain("token=;");
      expect(res.body.message).toContain("Logged out successfully");
    });
  });

  // ==========================================
  // AUTH MIDDLEWARE TESTS (3 Cases)
  // ==========================================

  describe("Auth Middleware (protect)", () => {
    it("Reject requests without Authorization headers", async () => {
      const res = await request(app).get("/api/auth/me");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("no token provided");
    });

    it("Reject malformed or expired JWT Bearer token", async () => {
      const res = await request(app)
        .get("/api/auth/me")
        .set("Authorization", "Bearer bad-token-format");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("token failed");
    });

    it("Allow access to protected resource with valid JWT Bearer token", async () => {
      const user = await User.create({
        firebaseUid: "valid-auth-uid",
        fullName: "Valid User",
        email: "valid@test.com",
      });

      const token = jwt.sign(
        { id: user._id.toString(), email: user.email, role: user.role },
        process.env.JWT_SECRET!
      );

      const res = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user._id).toBe(user._id.toString());
    });
  });

  // ==========================================
  // USER API TESTS (2 Cases)
  // ==========================================

  describe("User API", () => {
    it("Perform profile modifications", async () => {
      const user = await User.create({
        firebaseUid: "mod-uid",
        fullName: "Original Name",
        email: "original@test.com",
      });

      const token = jwt.sign(
        { id: user._id.toString(), email: user.email, role: user.role },
        process.env.JWT_SECRET!
      );

      const res = await request(app)
        .put("/api/users/profile")
        .set("Authorization", `Bearer ${token}`)
        .send({ fullName: "Modified Name", isActive: false });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.fullName).toBe("Modified Name");
      expect(res.body.user.isActive).toBe(false);
    });

    it("Cascade delete profile, workspace, forms, and responses", async () => {
      const user = await User.create({
        firebaseUid: "cascade-uid",
        fullName: "Cascade User",
        email: "cascade@test.com",
      });

      const workspace = await Workspace.create({
        name: "Cascade Workspace",
        owner: user._id,
      });

      user.workspaceId = workspace._id as any;
      await user.save();

      const form = await Form.create({
        title: "Cascade Form",
        workspaceId: workspace._id,
      });

      const response = await ResponseModel.create({
        formId: form._id,
        answers: { question: "answer" },
      });

      const token = jwt.sign(
        { id: user._id.toString(), email: user.email, role: user.role },
        process.env.JWT_SECRET!
      );

      const res = await request(app)
        .delete("/api/users/profile")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify cascading database deletion
      expect(await User.findById(user._id)).toBeNull();
      expect(await Workspace.findById(workspace._id)).toBeNull();
      expect(await Form.findById(form._id)).toBeNull();
      expect(await ResponseModel.findById(response._id)).toBeNull();
    });
  });

  // ==========================================
  // WORKSPACE API TESTS (1 Case)
  // ==========================================

  describe("Workspace API", () => {
    it("Complete workspace CRUD lifecycle tests", async () => {
      const user = await User.create({
        firebaseUid: "ws-uid",
        fullName: "WS Owner",
        email: "ws-owner@test.com",
      });

      const token = jwt.sign(
        { id: user._id.toString(), email: user.email, role: user.role },
        process.env.JWT_SECRET!
      );

      // 1. Create Workspace
      const createRes = await request(app)
        .post("/api/workspaces")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Lifecycle Workspace", description: "Fresh start" });

      expect(createRes.status).toBe(201);
      const wsId = createRes.body.workspace._id;

      // 2. Read Workspace
      const readRes = await request(app)
        .get(`/api/workspaces/${wsId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(readRes.status).toBe(200);
      expect(readRes.body.workspace.name).toBe("Lifecycle Workspace");

      // 3. Update Workspace
      const updateRes = await request(app)
        .put(`/api/workspaces/${wsId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Updated Workspace Title", description: "Modified desc" });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.workspace.name).toBe("Updated Workspace Title");

      // 4. Delete Workspace
      const deleteRes = await request(app)
        .delete(`/api/workspaces/${wsId}`)
        .set("Authorization", `Bearer ${token}`);

      expect(deleteRes.status).toBe(200);
      expect(await Workspace.findById(wsId)).toBeNull();
    });
  });

  // ==========================================
  // FORM API TESTS (1 Case)
  // ==========================================

  describe("Form API", () => {
    it("Form CRUD operations, submission validation, and submissions GET", async () => {
      const user = await User.create({
        firebaseUid: "form-uid",
        fullName: "Form Builder",
        email: "builder@test.com",
      });

      const workspace = await Workspace.create({
        name: "Form Workspace",
        owner: user._id,
      });

      user.workspaceId = workspace._id as any;
      await user.save();

      const token = jwt.sign(
        { id: user._id.toString(), email: user.email, role: user.role },
        process.env.JWT_SECRET!
      );

      // 1. Create Form
      const fields = [
        { label: "Full Name", type: "short_text", required: true },
        { label: "Favorite color", type: "dropdown", required: false, options: ["Red", "Blue", "Green"] }
      ];

      const createRes = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Feedback Form", fields });

      expect(createRes.status).toBe(201);
      const formId = createRes.body.form._id;

      // 2. Read Form
      const readRes = await request(app)
        .get(`/api/forms/${formId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(readRes.status).toBe(200);
      expect(readRes.body.form.title).toBe("Feedback Form");

      // 3. Submit Form (fails validation because required field 'Full Name' is missing)
      const badSubRes1 = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Favorite color": "Blue" } });

      expect(badSubRes1.status).toBe(422);
      expect(badSubRes1.body.success).toBe(false);
      expect(badSubRes1.body.errors[0].message).toContain("required");

      // 4. Submit Form (fails validation because dropdown selection is invalid)
      const badSubRes2 = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Full Name": "Jayesh", "Favorite color": "Yellow" } });

      expect(badSubRes2.status).toBe(422);
      expect(badSubRes2.body.success).toBe(false);
      expect(badSubRes2.body.errors[0].message).toContain("not a valid option");

      // 5. Submit Form (Success)
      const goodSubRes = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Full Name": "Jayesh", "Favorite color": "Blue" } });

      expect(goodSubRes.status).toBe(201);
      expect(goodSubRes.body.success).toBe(true);

      // 6. Get Submissions
      const subRes = await request(app)
        .get(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`);

      expect(subRes.status).toBe(200);
      expect(subRes.body.submissions.length).toBe(1);
      expect(subRes.body.submissions[0].answers["Full Name"]).toBe("Jayesh");
    });

    it("Support querying forms by search, status, and pagination", async () => {
      const user = await User.create({
        firebaseUid: "query-uid",
        fullName: "Query Builder",
        email: "query@test.com",
      });

      const workspace = await Workspace.create({
        name: "Query Workspace",
        owner: user._id,
      });

      user.workspaceId = workspace._id as any;
      await user.save();

      const token = jwt.sign(
        { id: user._id.toString(), email: user.email, role: user.role },
        process.env.JWT_SECRET!
      );

      // Create forms with different statuses and titles
      await Form.create({ title: "Registration Form", workspaceId: workspace._id, status: "draft" });
      await Form.create({ title: "Feedback Survey", workspaceId: workspace._id, status: "draft" });
      await Form.create({ title: "Contact Us", workspaceId: workspace._id, status: "closed" });

      // 1. Search Query
      const searchRes = await request(app)
        .get("/api/forms?search=Survey")
        .set("Authorization", `Bearer ${token}`);
      expect(searchRes.status).toBe(200);
      expect(searchRes.body.forms.length).toBe(1);
      expect(searchRes.body.forms[0].title).toBe("Feedback Survey");

      // 2. Status Filter Query
      const statusRes = await request(app)
        .get("/api/forms?status=closed")
        .set("Authorization", `Bearer ${token}`);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.forms.length).toBe(1);
      expect(statusRes.body.forms[0].title).toBe("Contact Us");

      // 3. Pagination Query
      const pagRes = await request(app)
        .get("/api/forms?page=2&limit=2")
        .set("Authorization", `Bearer ${token}`);
      expect(pagRes.status).toBe(200);
      expect(pagRes.body.page).toBe(2);
      expect(pagRes.body.limit).toBe(2);
      expect(pagRes.body.forms.length).toBe(1); // Page 2 with limit 2 returns 1 form
    });
  });

  // ==========================================
  // AUTHORIZATION TESTS (1 Case)
  // ==========================================

  describe("Authorization Boundary Checks", () => {
    it("Verify User B cannot modify/delete User A's workspace or forms", async () => {
      const userA = await User.create({ firebaseUid: "ua", fullName: "User A", email: "a@test.com" });
      const userB = await User.create({ firebaseUid: "ub", fullName: "User B", email: "b@test.com" });

      const wsA = await Workspace.create({ name: "Workspace A", owner: userA._id });
      const formA = await Form.create({ title: "Form A", workspaceId: wsA._id });

      const tokenB = jwt.sign(
        { id: userB._id.toString(), email: userB.email, role: userB.role },
        process.env.JWT_SECRET!
      );

      // 1. User B updates User A's workspace -> Forbidden
      const wsRes = await request(app)
        .put(`/api/workspaces/${wsA._id}`)
        .set("Authorization", `Bearer ${tokenB}`)
        .send({ name: "Hijacked" });

      expect(wsRes.status).toBe(403);

      // 2. User B updates User A's form -> Forbidden
      const formRes = await request(app)
        .put(`/api/forms/${formA._id}`)
        .set("Authorization", `Bearer ${tokenB}`)
        .send({ title: "Hijacked Form" });

      expect(formRes.status).toBe(403);
    });
  });

  // ==========================================
  // DASHBOARD API TESTS (1 Case)
  // ==========================================

  describe("Dashboard Analytics API", () => {
    it("Aggregate total forms, responses, and activity breakdown", async () => {
      const user = await User.create({
        firebaseUid: "dash-uid",
        fullName: "Dash User",
        email: "dash@test.com",
      });

      const workspace = await Workspace.create({
        name: "Dash Workspace",
        owner: user._id,
      });

      user.workspaceId = workspace._id as any;
      await user.save();

      const form1 = await Form.create({ title: "Form 1", workspaceId: workspace._id });
      const form2 = await Form.create({ title: "Form 2", workspaceId: workspace._id });

      await ResponseModel.create({ formId: form1._id, answers: { key: "a" } });
      await ResponseModel.create({ formId: form1._id, answers: { key: "b" } });

      const token = jwt.sign(
        { id: user._id.toString(), email: user.email, role: user.role },
        process.env.JWT_SECRET!
      );

      const res = await request(app)
        .get("/api/dashboard/analytics")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.analytics.totalForms).toBe(2);
      expect(res.body.analytics.totalResponses).toBe(2);
      
      const breakdown = res.body.analytics.formsBreakdown;
      expect(breakdown.length).toBe(2);
      expect(breakdown.find((f: any) => f.title === "Form 1").responseCount).toBe(2);
      expect(breakdown.find((f: any) => f.title === "Form 2").responseCount).toBe(0);
    });
  });

  // ==========================================
  // ERROR HANDLING TESTS (1 Case)
  // ==========================================

  describe("Global Error Handling Middleware", () => {
    it("Catch mongoose invalid ObjectId casts globally", async () => {
      const user = await User.create({
        firebaseUid: "cast-test-uid",
        fullName: "Cast Test User",
        email: "cast_test@test.com",
        role: "admin",
      });
      const token = jwt.sign(
        { id: user._id.toString(), email: user.email, role: user.role },
        process.env.JWT_SECRET!
      );
      const res = await request(app)
        .post("/api/forms/invalid-objectid-format/submissions")
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: {} });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Cast to ObjectId failed");
    });
  });

  // ==========================================
  // RESPONSE TIME TESTS (1 Case)
  // ==========================================

  describe("API Response Time SLA Check", () => {
    it("Assert endpoint response times are within limits (<200ms)", async () => {
      const startTime = Date.now();
      const res = await request(app).get("/api/health");
      const duration = Date.now() - startTime;

      expect(res.status).toBe(200);
      expect(duration).toBeLessThan(200); // Should be well under 200ms
    });
  });

  // ==========================================
  // PERFORMANCE TESTS (1 Case)
  // ==========================================

  describe("API Concurrent Load Performance Check", () => {
    it("Concurrent execution of 21 requests without performance degradation", async () => {
      const requests = Array.from({ length: 21 }, () =>
        request(app).get("/api/health")
      );

      const startTime = Date.now();
      const responses = await Promise.all(requests);
      const totalTime = Date.now() - startTime;

      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      // Assert total concurrent execution finishes in a reasonable time
      expect(totalTime).toBeLessThan(1000); 
    });
  });

  // ==========================================
  // CROSS-WORKSPACE ISOLATION & COOKIE TESTS
  // ==========================================

  describe("Cross-Workspace Isolation & Cookie Authentication", () => {
    let adminA: any;
    let adminB: any;
    let wsA: any;
    let wsB: any;
    let formA: any;
    let tokenA: string;
    let tokenB: string;

    beforeEach(async () => {
      // Create Admin A and Admin B users
      adminA = await User.create({
        firebaseUid: "admin-a-uid",
        fullName: "Admin A",
        email: "admina@test.com",
        role: "admin",
      });

      adminB = await User.create({
        firebaseUid: "admin-b-uid",
        fullName: "Admin B",
        email: "adminb@test.com",
        role: "admin",
      });

      // Create workspaces
      wsA = await Workspace.create({
        name: "Workspace A",
        owner: adminA._id,
      });

      wsB = await Workspace.create({
        name: "Workspace B",
        owner: adminB._id,
      });

      adminA.workspaceId = wsA._id;
      await adminA.save();

      adminB.workspaceId = wsB._id;
      await adminB.save();

      // Create a form belonging to Workspace A
      formA = await Form.create({
        title: "Admin A's Form",
        description: "Form belonging to Workspace A",
        workspaceId: wsA._id,
        status: "draft",
        fields: [{ label: "Name", type: "short_text", required: true }],
      });

      // Generate tokens
      tokenA = jwt.sign(
        { id: adminA._id.toString(), email: adminA.email, role: adminA.role },
        process.env.JWT_SECRET!
      );

      tokenB = jwt.sign(
        { id: adminB._id.toString(), email: adminB.email, role: adminB.role },
        process.env.JWT_SECRET!
      );
    });

    it("Confirm Admin B cannot GET Admin A's form (403)", async () => {
      const res = await request(app)
        .get(`/api/forms/${formA._id}`)
        .set("Authorization", `Bearer ${tokenB}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain("Forbidden");
    });

    it("Confirm Admin B cannot PATCH Admin A's form (403)", async () => {
      const res = await request(app)
        .patch(`/api/forms/${formA._id}`)
        .set("Authorization", `Bearer ${tokenB}`)
        .send({ title: "Hijacked Title" });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain("Forbidden");
    });

    it("Confirm Admin B cannot DELETE Admin A's form (403)", async () => {
      const res = await request(app)
        .delete(`/api/forms/${formA._id}`)
        .set("Authorization", `Bearer ${tokenB}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain("Forbidden");
    });

    it("Confirm Admin A can PATCH their own form (autosave partial validation checks)", async () => {
      // Autosave sending a short/partial title should be allowed on patch
      const res = await request(app)
        .patch(`/api/forms/${formA._id}`)
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ title: "A" }); // short title is permitted

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.form.title).toBe("A");

      // Form status change and field update
      const resFields = await request(app)
        .patch(`/api/forms/${formA._id}`)
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ status: "closed" });

      expect(resFields.status).toBe(200);
      expect(resFields.body.form.status).toBe("closed");
    });

    it("Confirm Admin A can DELETE their own form (removes form and its responses)", async () => {
      // Submit a response to the form first
      const sub = await ResponseModel.create({
        formId: formA._id,
        answers: { Name: "Jayesh" },
      });

      const res = await request(app)
        .delete(`/api/forms/${formA._id}`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(204);

      // Confirm both form and its responses are deleted
      expect(await Form.findById(formA._id)).toBeNull();
      expect(await ResponseModel.findById(sub._id)).toBeNull();
    });

    it("Return 401 when the JWT cookie or Authorization header is missing", async () => {
      const res = await request(app).get(`/api/forms/${formA._id}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain("no token provided");
    });

    it("Allow access when the JWT cookie is present (cookie authorization support)", async () => {
      // Test sending jwt cookie
      const resJwt = await request(app)
        .get(`/api/forms/${formA._id}`)
        .set("Cookie", `jwt=${tokenA}`);

      expect(resJwt.status).toBe(200);
      expect(resJwt.body.success).toBe(true);
      expect(resJwt.body.form.title).toBe("Admin A's Form");

      // Test sending token cookie
      const resToken = await request(app)
        .get(`/api/forms/${formA._id}`)
        .set("Cookie", `token=${tokenA}`);

      expect(resToken.status).toBe(200);
      expect(resToken.body.success).toBe(true);
    });

    it("Return 404 when the form is not in the workspace (not in database/non-existent)", async () => {
      const nonExistentFormId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .get(`/api/forms/${nonExistentFormId}`)
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain("Form not found");
    });

    it("Reject when workspaceId is explicitly passed in body or params", async () => {
      const resBody = await request(app)
        .patch(`/api/forms/${formA._id}`)
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ workspaceId: wsA._id.toString() });

      expect(resBody.status).toBe(400);
      expect(resBody.body.success).toBe(false);
      expect(resBody.body.message).toContain("workspaceId must not be provided");
    });
  });

  // =========================================================================
  // 10 FIELD TYPES & COMPREHENSIVE DYNAMIC VALIDATION TESTS
  // =========================================================================
  describe("Discriminated Union, Immutability, Soft Delete & Dynamic Validation", () => {
    let adminUser: any;
    let token: string;
    let ws: any;

    beforeEach(async () => {
      adminUser = await User.create({
        firebaseUid: "adv-uid",
        fullName: "Advanced Admin",
        email: "advanced@test.com",
        role: "admin",
      });
      ws = await Workspace.create({
        name: "Advanced Workspace",
        owner: adminUser._id,
      });
      adminUser.workspaceId = ws._id;
      await adminUser.save();

      token = jwt.sign(
        { id: adminUser._id.toString(), email: adminUser.email, role: adminUser.role },
        process.env.JWT_SECRET!
      );
    });

    it("Create a form successfully with all 10 field types populated correctly", async () => {
      const fields = [
        { label: "Short Text Field", type: "short_text", required: true, minLength: 2, maxLength: 10 },
        { label: "Long Text Field", type: "long_text", required: false, minLength: 5, maxLength: 100 },
        { label: "Email Field", type: "email", required: true },
        { label: "Phone Field", type: "phone", required: false, pattern: "^\\+?[0-9]{10,15}$" },
        { label: "Number Field", type: "number", required: true, min: 10, max: 100 },
        { label: "Date Field", type: "date", required: false, minDate: "2026-01-01", maxDate: "2026-12-31" },
        { label: "Dropdown Field", type: "dropdown", required: true, options: ["Apple", "Banana", "Cherry"] },
        { label: "Multiple Choice Field", type: "multiple_choice", required: true, options: ["Yes", "No", "Maybe"] },
        { label: "Checkbox Field", type: "checkbox", required: false, options: ["Red", "Green", "Blue"] },
        { label: "File Upload Field", type: "file_upload", required: false, maxFileSize: 5, allowedMimeTypes: ["image/png", "application/pdf"] }
      ];

      const res = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "10 Fields Form", fields });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.form.fields).toHaveLength(10);
      expect(res.body.form.schemaVersion).toBe(1);

      // Verify that fieldIds are automatically generated
      for (const field of res.body.form.fields) {
        expect(field.fieldId).toBeDefined();
        expect(field.deleted).toBe(false);
      }
    });

    it("Reject invalid field schemas with a 400 and descriptive messages", async () => {
      const badFields = [
        { label: "Bad Text", type: "short_text", minLength: 10, maxLength: 5 }, // minLength > maxLength
        { label: "Bad Number", type: "number", min: 100, max: 50 },      // min > max
        { label: "Bad Date", type: "date", minDate: "2026-12-31", maxDate: "2026-01-01" }, // minDate > maxDate
        { label: "Bad Dropdown", type: "dropdown", options: [] },        // empty options
        { label: "Bad MC", type: "multiple_choice", options: [""] },     // empty option string
        { label: "Bad File", type: "file_upload", maxFileSize: -2 }             // negative file size
      ];

      for (const bad of badFields) {
        const res = await request(app)
          .post("/api/forms")
          .set("Authorization", `Bearer ${token}`)
          .send({ title: "Bad Form", fields: [bad] });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error.message).toContain("Validation failed");
        expect(res.body.errors).toBeDefined();
      }
    });

    it("Enforce soft-delete rule (mark deleted: true, never remove) and increment schemaVersion", async () => {
      // 1. Create form with two fields
      const createRes = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Soft Delete Form",
          fields: [
            { label: "First Field", type: "short_text", required: true },
            { label: "Second Field", type: "number", required: false }
          ]
        });

      expect(createRes.status).toBe(201);
      const form = createRes.body.form;
      const f1 = form.fields[0];
      const f2 = form.fields[1];
      expect(form.schemaVersion).toBe(1);

      // 2. Perform a PUT/update where we omit the Second Field and modify the First Field
      // The update should soft-delete the Second Field, keep it in the list with deleted: true, and increment schemaVersion
      const updateRes = await request(app)
        .put(`/api/forms/${form._id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Soft Delete Form Updated",
          fields: [
            { fieldId: f1.fieldId, label: "First Field Renamed", type: "short_text", required: true }
          ]
        });

      expect(updateRes.status).toBe(200);
      const updatedForm = updateRes.body.form;
      expect(updatedForm.schemaVersion).toBe(2);

      // Check fields: both should exist, Second Field marked as deleted
      expect(updatedForm.fields).toHaveLength(2);

      const field1 = updatedForm.fields.find((f: any) => f.fieldId === f1.fieldId);
      const field2 = updatedForm.fields.find((f: any) => f.fieldId === f2.fieldId);

      expect(field1.label).toBe("First Field Renamed");
      expect(field1.deleted).toBe(false);

      expect(field2.label).toBe("Second Field");
      expect(field2.deleted).toBe(true); // Soft-deleted!
    });

    it("Enforce that existing fieldId is immutable during form update", async () => {
      const createRes = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Immutability Form",
          fields: [
            { label: "Static Field", type: "short_text" }
          ]
        });

      const form = createRes.body.form;
      const originalFieldId = form.fields[0].fieldId;

      // Update the form where we send a different fieldId at the same index
      // The backend should treat the old fieldId as soft-deleted and create a new field with the new ID
      const updateRes = await request(app)
        .put(`/api/forms/${form._id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Immutability Form",
          fields: [
            { fieldId: "new-mutated-id", label: "Static Field", type: "short_text" }
          ]
        });

      expect(updateRes.status).toBe(200);
      const fields = updateRes.body.form.fields;
      expect(fields).toHaveLength(2);

      const originalField = fields.find((f: any) => f.fieldId === originalFieldId);
      const newField = fields.find((f: any) => f.fieldId === "new-mutated-id");

      expect(originalField.deleted).toBe(true); // Omitted/old fieldId soft-deleted
      expect(newField.deleted).toBe(false);      // New fieldId added
    });

    it("Perform complete dynamic answer validation on submission for all 10 types", async () => {
      const createRes = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Submission Validator Form",
          fields: [
            { label: "Text", type: "short_text", required: true, minLength: 3, maxLength: 8 },
            { label: "Textarea", type: "long_text", required: false, minLength: 5 },
            { label: "Email", type: "email", required: true },
            { label: "Phone", type: "phone", pattern: "^\\+1[0-9]{10}$" },
            { label: "Number", type: "number", min: 10, max: 20 },
            { label: "Date", type: "date", minDate: "2026-06-01", maxDate: "2026-06-30" },
            { label: "Dropdown", type: "dropdown", options: ["A", "B"] },
            { label: "MultipleChoice", type: "multiple_choice", options: ["Yes", "No"] },
            { label: "CheckboxSingle", type: "checkbox" },
            { label: "CheckboxMulti", type: "checkbox", options: ["Red", "Blue"] },
            { label: "File", type: "file_upload", maxFileSize: 2, allowedMimeTypes: ["image/jpeg"] }
          ]
        });

      const formId = createRes.body.form._id;

      // 1. Check required validation
      const badReq = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: {} });
      expect(badReq.status).toBe(422);
      expect(badReq.body.message).toContain("Validation failed");
      expect(badReq.body.errors[0].message).toContain("required");

      // 2. Check Text length validations
      const badTextShort = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Text": "ab", "Email": "a@b.com" } });
      expect(badTextShort.status).toBe(422);
      expect(badTextShort.body.errors[0].message).toContain("must be at least 3 characters");

      const badTextLong = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Text": "abcdefghi", "Email": "a@b.com" } });
      expect(badTextLong.status).toBe(422);
      expect(badTextLong.body.errors[0].message).toContain("cannot exceed 8 characters");

      // 3. Check Email format validation
      const badEmail = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Text": "abcdef", "Email": "invalid-email" } });
      expect(badEmail.status).toBe(422);
      expect(badEmail.body.errors[0].message).toContain("must be a valid email address");

      // 4. Check Phone pattern validation
      const badPhone = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Text": "abcdef", "Email": "a@b.com", "Phone": "12345" } });
      expect(badPhone.status).toBe(422);
      expect(badPhone.body.errors[0].message).toContain("must match format pattern");

      // 5. Check Number bounds validation
      const badNumMin = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Text": "abcdef", "Email": "a@b.com", "Number": 5 } });
      expect(badNumMin.status).toBe(422);
      expect(badNumMin.body.errors[0].message).toContain("must be at least 10");

      const badNumMax = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Text": "abcdef", "Email": "a@b.com", "Number": 25 } });
      expect(badNumMax.status).toBe(422);
      expect(badNumMax.body.errors[0].message).toContain("cannot exceed 20");

      // 6. Check Date limits validation
      const badDateMin = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Text": "abcdef", "Email": "a@b.com", "Date": "2026-05-15" } });
      expect(badDateMin.status).toBe(422);
      expect(badDateMin.body.errors[0].message).toContain("cannot be earlier than 2026-06-01");

      const badDateMax = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Text": "abcdef", "Email": "a@b.com", "Date": "2026-07-01" } });
      expect(badDateMax.status).toBe(422);
      expect(badDateMax.body.errors[0].message).toContain("cannot be later than 2026-06-30");

      // 7. Check Dropdown / MultipleChoice validation
      const badDropdown = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Text": "abcdef", "Email": "a@b.com", "Dropdown": "C" } });
      expect(badDropdown.status).toBe(422);
      expect(badDropdown.body.errors[0].message).toContain("not a valid option");

      // 8. Check Checkbox validation (single boolean vs multi-select array)
      const badCheckboxSingle = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Text": "abcdef", "Email": "a@b.com", "CheckboxSingle": "yes" } });
      expect(badCheckboxSingle.status).toBe(422);
      expect(badCheckboxSingle.body.errors[0].message).toContain("must be a boolean");

      const badCheckboxMulti = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({ answers: { "Text": "abcdef", "Email": "a@b.com", "CheckboxMulti": ["Green"] } });
      expect(badCheckboxMulti.status).toBe(422);
      expect(badCheckboxMulti.body.errors[0].message).toContain("not a valid option for checkbox field");

      // 9. Check File upload validation
      const badFileSize = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          answers: {
            "Text": "abcdef",
            "Email": "a@b.com",
            "File": { fileName: "photo.jpg", fileSize: 3 * 1024 * 1024, mimeType: "image/jpeg" } // 3MB exceeds 2MB
          }
        });
      expect(badFileSize.status).toBe(422);
      expect(badFileSize.body.errors[0].message).toContain("file size exceeds the limit");

      const badFileMime = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          answers: {
            "Text": "abcdef",
            "Email": "a@b.com",
            "File": { fileName: "document.pdf", fileSize: 1 * 1024 * 1024, mimeType: "application/pdf" } // mime pdf not allowed
          }
        });
      expect(badFileMime.status).toBe(422);
      expect(badFileMime.body.errors[0].message).toContain("file type \"application/pdf\" is not allowed");

      // 10. Valid Submission (Success)
      const goodRes = await request(app)
        .post(`/api/forms/${formId}/submissions`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          answers: {
            "Text": "abcdef",
            "Textarea": "Hello World",
            "Email": "test@domain.com",
            "Phone": "+12345678901",
            "Number": 15,
            "Date": "2026-06-15",
            "Dropdown": "A",
            "MultipleChoice": "Yes",
            "CheckboxSingle": true,
            "CheckboxMulti": ["Red", "Blue"],
            "File": { fileName: "photo.jpg", fileSize: 1 * 1024 * 1024, mimeType: "image/jpeg" }
          }
        });
      expect(goodRes.status).toBe(201);
      expect(goodRes.body.success).toBe(true);
    });

    it("Successfully duplicate a form with prefixed title, new slug, same fields, and verify no responses are copied", async () => {
      // 1. Create a form with a custom slug and publishedSlug
      const createRes = await request(app)
        .post("/api/forms")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Source Form",
          slug: "custom-slug-123",
          publishedSlug: "published-slug-456",
          fields: [{ label: "Name", type: "short_text" }]
        });

      const originalForm = createRes.body.form;

      // 2. Submit a response to the original form
      await ResponseModel.create({
        formId: originalForm._id,
        answers: { Name: "Jayesh" }
      });

      // 3. Duplicate the form
      const dupRes = await request(app)
        .post(`/api/forms/${originalForm._id}/duplicate`)
        .set("Authorization", `Bearer ${token}`);

      expect(dupRes.status).toBe(201);
      expect(dupRes.body.success).toBe(true);

      const duplicatedForm = dupRes.body.form;

      // Assertions
      expect(duplicatedForm._id).not.toBe(originalForm._id);
      expect(duplicatedForm.title).toBe("Copy of Source Form");
      expect(duplicatedForm.slug).toBeDefined();
      expect(duplicatedForm.slug).not.toBe(originalForm.slug);
      expect(duplicatedForm.publishedSlug).toBeUndefined(); // Omitted!
      expect(duplicatedForm.workspaceId.toString()).toBe(originalForm.workspaceId.toString());
      expect(duplicatedForm.fields).toHaveLength(1);
      expect(duplicatedForm.fields[0].label).toBe(originalForm.fields[0].label);

      // Verify no responses are carried over
      const originalResponses = await ResponseModel.find({ formId: originalForm._id });
      const duplicatedResponses = await ResponseModel.find({ formId: duplicatedForm._id });
      expect(originalResponses).toHaveLength(1);
      expect(duplicatedResponses).toHaveLength(0);
    });

    it("Block User B from duplicating User A's form (403)", async () => {
      const userA = await User.create({ firebaseUid: "ua-dup", fullName: "User A", email: "a.dup@test.com" });
      const userB = await User.create({ firebaseUid: "ub-dup", fullName: "User B", email: "b.dup@test.com" });

      const wsA = await Workspace.create({ name: "Workspace A", owner: userA._id });
      const formA = await Form.create({ title: "Form A", workspaceId: wsA._id });

      const tokenB = jwt.sign(
        { id: userB._id.toString(), email: userB.email, role: userB.role },
        process.env.JWT_SECRET!
      );

      const res = await request(app)
        .post(`/api/forms/${formA._id}/duplicate`)
        .set("Authorization", `Bearer ${tokenB}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain("Forbidden");
    });
  });
});

