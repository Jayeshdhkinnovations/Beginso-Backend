// Mock Firebase Admin Authentication offline
jest.mock("firebase-admin/auth", () => {
  return {
    getAuth: () => {
      return {
        createUser: async (data: any) => ({ uid: `mock-uid-${data.email}` }),
        verifyIdToken: async (token: string) => ({
          uid: `mock-uid-${token}`,
          email: `${token}@test.com`,
          name: `User ${token}`,
        }),
        deleteUser: async () => ({}),
        revokeRefreshTokens: async () => {},
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
import Invitation from "../models/Invitation";
import ResponseModel from "../models/Response";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;

let ownerUser: any;
let ownerToken: string;

let memberUser: any;
let memberToken: string;

let workspace: any;

process.env.JWT_SECRET = "test-jwt-secret-key-for-sticky-workspace-fix";

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
  await Invitation.init();

  // 1. Create Workspace Owner
  ownerUser = await User.create({
    firebaseUid: "uid-owner-sticky",
    fullName: "Owner User",
    email: "owner_sticky@test.com",
    role: "admin",
    status: "active",
  });
  ownerToken = makeToken(ownerUser);

  // 2. Create Workspace
  workspace = await Workspace.create({
    name: "Sticky Test Workspace",
    slug: "sticky-test-ws",
    owner: ownerUser._id,
  });
  ownerUser.workspaceId = workspace._id;
  await ownerUser.save();

  await Membership.create({
    workspaceId: workspace._id,
    userId: ownerUser._id,
    role: "owner",
  });

  // 3. Create Fresh Member User
  memberUser = await User.create({
    firebaseUid: "uid-member-sticky",
    fullName: "Fresh Member",
    email: "fresh_member@test.com",
    role: "admin",
    status: "active",
  });
  memberToken = makeToken(memberUser);

  // 4. Invite and accept membership into workspace
  const inv = await Invitation.create({
    workspaceId: workspace._id,
    email: memberUser.email,
    role: "editor",
    token: "invite-token-sticky-member",
    invitedBy: ownerUser._id,
    status: "pending",
    expiresAt: new Date(Date.now() + 86400000),
  });

  const acceptRes = await request(app)
    .post(`/api/invitations/${inv.token}/accept`)
    .set("Authorization", `Bearer ${memberToken}`);

  expect(acceptRes.status).toBe(200);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe("Sticky Default Workspace Fixes (Round 3)", () => {
  it("POST /api/forms honors explicit personal destination with destination: { type: 'personal' }, destinationWorkspaceId: null", async () => {
    const payload = {
      title: "My Personal Form via Destination Object",
      destination: { type: "personal" },
      destinationWorkspaceId: null,
      fields: [
        {
          fieldId: "f_name",
          type: "short_text",
          label: "Your Name",
          required: true,
        },
      ],
    };

    const res = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${memberToken}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("My Personal Form via Destination Object");
    expect(res.body.workspaceId).toBeNull();
    expect(res.body.createdBy.toString()).toBe(memberUser._id.toString());
  });

  it("POST /api/forms honors explicit personal destination with destinationWorkspaceId: null", async () => {
    const payload = {
      title: "My Personal Form via DestinationWorkspaceId Null",
      destinationWorkspaceId: null,
      fields: [
        {
          fieldId: "f_email",
          type: "email",
          label: "Email Address",
          required: false,
        },
      ],
    };

    const res = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${memberToken}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("My Personal Form via DestinationWorkspaceId Null");
    expect(res.body.workspaceId).toBeNull();
    expect(res.body.createdBy.toString()).toBe(memberUser._id.toString());
  });

  it("POST /api/forms honors explicit personal destination with workspaceId: null", async () => {
    const payload = {
      title: "My Personal Form via WorkspaceId Null",
      workspaceId: null,
      fields: [],
    };

    const res = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${memberToken}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("My Personal Form via WorkspaceId Null");
    expect(res.body.workspaceId).toBeNull();
  });

  it("POST /api/forms honors explicit workspace destination for editor member", async () => {
    const payload = {
      title: "Workspace Team Form",
      destinationWorkspaceId: workspace._id.toString(),
      fields: [],
    };

    const res = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${memberToken}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Workspace Team Form");
    expect(res.body.workspaceId.toString()).toBe(workspace._id.toString());
  });

  it("GET /api/dashboard/analytics strictly scopes to personal forms without leaking workspace forms", async () => {
    // 1. Owner creates a form in workspace
    await Form.create({
      title: "QA Test Form",
      workspaceId: workspace._id,
      createdBy: ownerUser._id,
      status: "published",
      fields: [],
    });

    // 2. Member has 3 personal forms created above and 1 workspace form
    // Member calls GET /api/dashboard/analytics (default personal scope, no x-workspace-id header)
    const resPersonal = await request(app)
      .get("/api/dashboard/analytics")
      .set("Authorization", `Bearer ${memberToken}`);

    expect(resPersonal.status).toBe(200);
    const dataPersonal = resPersonal.body.data || resPersonal.body.analytics;
    // Total forms must equal 3 personal forms created by member, NOT including "QA Test Form" or "Workspace Team Form"
    expect(dataPersonal.totalForms).toBe(3);
    const titles = dataPersonal.formsBreakdown.map((f: any) => f.title);
    expect(titles).toContain("My Personal Form via Destination Object");
    expect(titles).toContain("My Personal Form via DestinationWorkspaceId Null");
    expect(titles).toContain("My Personal Form via WorkspaceId Null");
    expect(titles).not.toContain("QA Test Form");
    expect(titles).not.toContain("Workspace Team Form");

    // 3. Member calls GET /api/dashboard/analytics?workspaceId=personal
    const resExplicitPersonal = await request(app)
      .get("/api/dashboard/analytics?workspaceId=personal")
      .set("Authorization", `Bearer ${memberToken}`);

    expect(resExplicitPersonal.status).toBe(200);
    const dataExplicit = resExplicitPersonal.body.data || resExplicitPersonal.body.analytics;
    expect(dataExplicit.totalForms).toBe(3);

    // 4. Member calls GET /api/dashboard/analytics with x-workspace-id: workspace._id
    const resWorkspace = await request(app)
      .get("/api/dashboard/analytics")
      .set("Authorization", `Bearer ${memberToken}`)
      .set("x-workspace-id", workspace._id.toString());

    expect(resWorkspace.status).toBe(200);
    const dataWorkspace = resWorkspace.body.data || resWorkspace.body.analytics;
    // Workspace contains 2 forms: "QA Test Form" (by owner) and "Workspace Team Form" (by member)
    expect(dataWorkspace.totalForms).toBe(2);
    const wsTitles = dataWorkspace.formsBreakdown.map((f: any) => f.title);
    expect(wsTitles).toContain("QA Test Form");
    expect(wsTitles).toContain("Workspace Team Form");
    expect(wsTitles).not.toContain("My Personal Form via Destination Object");
  });
});
