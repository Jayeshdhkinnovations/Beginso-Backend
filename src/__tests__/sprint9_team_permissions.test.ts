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
import fs from "fs";
import path from "path";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Invitation from "../models/Invitation";
import FormAccessGrant from "../models/FormAccessGrant";
import SessionModel from "../models/Session";
import Upload from "../models/Upload";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;

let ownerUser: any;
let ownerToken: string;

let adminUser: any;
let adminToken: string;

let editorUser: any;
let editorToken: string;

let reviewerUser: any;
let reviewerToken: string;

let outsiderUser: any;
let outsiderToken: string;

let workspace: any;

process.env.JWT_SECRET = "test-jwt-secret-key-for-sprint9-team-permissions-suite";

const makeToken = (user: any, sessionId?: string) =>
  generateToken({
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    ...(sessionId ? { sessionId } : {}),
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
  await FormAccessGrant.init();
  await SessionModel.init();

  // Create Workspace Owner
  ownerUser = await User.create({
    firebaseUid: "uid-owner-s9",
    fullName: "Owner User",
    email: "owner_s9@test.com",
    role: "admin",
    status: "active",
  });

  workspace = await Workspace.create({
    name: "Team Sprint 9 Workspace",
    slug: "team-sprint-9-ws",
    timezone: "UTC",
    owner: ownerUser._id,
  });

  ownerUser.workspaceId = workspace._id;
  await ownerUser.save();

  await Membership.create({
    userId: ownerUser._id,
    workspaceId: workspace._id,
    role: "owner",
  });
  ownerToken = makeToken(ownerUser);

  // Create Admin User
  adminUser = await User.create({
    firebaseUid: "uid-admin-s9",
    fullName: "Admin User",
    email: "admin_s9@test.com",
    role: "admin",
    status: "active",
    workspaceId: workspace._id,
  });
  await Membership.create({
    userId: adminUser._id,
    workspaceId: workspace._id,
    role: "admin",
  });
  adminToken = makeToken(adminUser);

  // Create Editor User
  editorUser = await User.create({
    firebaseUid: "uid-editor-s9",
    fullName: "Editor User",
    email: "editor_s9@test.com",
    role: "admin",
    status: "active",
    workspaceId: workspace._id,
  });
  await Membership.create({
    userId: editorUser._id,
    workspaceId: workspace._id,
    role: "editor",
  });
  editorToken = makeToken(editorUser);

  // Create Reviewer User
  reviewerUser = await User.create({
    firebaseUid: "uid-reviewer-s9",
    fullName: "Reviewer User",
    email: "reviewer_s9@test.com",
    role: "admin",
    status: "active",
    workspaceId: workspace._id,
  });
  await Membership.create({
    userId: reviewerUser._id,
    workspaceId: workspace._id,
    role: "reviewer",
  });
  reviewerToken = makeToken(reviewerUser);

  // Create Outsider User (not member of workspace)
  outsiderUser = await User.create({
    firebaseUid: "uid-outsider-s9",
    fullName: "Outsider User",
    email: "outsider_s9@test.com",
    role: "admin",
    status: "active",
    workspaceId: null,
  });
  outsiderToken = makeToken(outsiderUser);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("Sprint 9 — Team & Permissions Backend Contracts [BE 0.1 - BE 0.8]", () => {
  // =========================================================================
  // BE 0.1: GET /api/workspaces/:id — add caller's role/isOwner
  // =========================================================================
  describe("BE 0.1 — GET /api/workspaces/:id caller's role & isOwner", () => {
    it("returns role='owner' and isOwner=true for workspace owner", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspace._id}`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const ws = res.body.workspace || res.body.data;
      expect(ws).toBeDefined();
      expect(ws.role).toBe("owner");
      expect(ws.isOwner).toBe(true);
    });

    it("returns role='admin' and isOwner=false for admin member", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspace._id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const ws = res.body.workspace || res.body.data;
      expect(ws.role).toBe("admin");
      expect(ws.isOwner).toBe(false);
    });

    it("returns role='editor' and isOwner=false for editor member", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspace._id}`)
        .set("Authorization", `Bearer ${editorToken}`);

      expect(res.status).toBe(200);
      const ws = res.body.workspace || res.body.data;
      expect(ws.role).toBe("editor");
      expect(ws.isOwner).toBe(false);
    });

    it("returns 403 for outsider who is not a member of the workspace", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspace._id}`)
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect([403, 404]).toContain(res.status);
    });
  });

  // =========================================================================
  // BE 0.2: Workspace Member Management
  // =========================================================================
  describe("BE 0.2 — Workspace Member Management (GET, PATCH role, DELETE)", () => {
    it("GET /api/workspaces/:id/members lists all workspace members", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspace._id}/members`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.members)).toBe(true);
      expect(res.body.members.length).toBeGreaterThanOrEqual(4);

      const roles = res.body.members.map((m: any) => m.role);
      expect(roles).toContain("owner");
      expect(roles).toContain("admin");
      expect(roles).toContain("editor");
      expect(roles).toContain("reviewer");

      const first = res.body.members[0];
      expect(first).toHaveProperty("userId");
      expect(first).toHaveProperty("membershipId");
      expect(first).toHaveProperty("isOwner");
      expect(first).toHaveProperty("avatarUrl");
      expect(first).toHaveProperty("lastActiveAt");
      expect(first).toHaveProperty("name");
      expect(first).toHaveProperty("email");
      expect(first).toHaveProperty("role");
      expect(first).toHaveProperty("joinedAt");
    });

    it("PATCH /api/workspaces/:id/members/:userId updates member role", async () => {
      const res = await request(app)
        .patch(`/api/workspaces/${workspace._id}/members/${reviewerUser._id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ role: "editor" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.member.role).toBe("editor");

      // Verify in DB
      const updatedMem = await Membership.findOne({
        workspaceId: workspace._id,
        userId: reviewerUser._id,
      });
      expect(updatedMem?.role).toBe("editor");
    });

    it("PATCH /api/workspaces/:id/members/:memberId works when keyed by membershipId instead of userId", async () => {
      const mem = await Membership.findOne({
        workspaceId: workspace._id,
        userId: reviewerUser._id,
      });
      expect(mem).not.toBeNull();

      const res = await request(app)
        .patch(`/api/workspaces/${workspace._id}/members/${mem!._id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ role: "reviewer" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.member.role).toBe("reviewer");
      expect(res.body.member.membershipId).toBe(mem!._id.toString());
    });

    it("PATCH /api/workspaces/:id/members/:userId rejects changing owner role", async () => {
      const res = await request(app)
        .patch(`/api/workspaces/${workspace._id}/members/${ownerUser._id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ role: "admin" });

      expect([400, 403]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("DELETE /api/workspaces/:id/members/:userId rejects removing owner", async () => {
      const res = await request(app)
        .delete(`/api/workspaces/${workspace._id}/members/${ownerUser._id}`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect([400, 403]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("DELETE rejects removing the last member in a single-member workspace", async () => {
      // Create temporary isolated workspace with single owner
      const soloWs = await Workspace.create({
        name: "Solo WS",
        slug: "solo-ws-s9",
        owner: outsiderUser._id,
      });
      await Membership.create({
        userId: outsiderUser._id,
        workspaceId: soloWs._id,
        role: "owner",
      });

      const res = await request(app)
        .delete(`/api/workspaces/${soloWs._id}/members/${outsiderUser._id}`)
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect([400, 403]).toContain(res.status);
    });

    it("DELETE /api/workspaces/:id/members/:userId successfully removes regular member", async () => {
      const res = await request(app)
        .delete(`/api/workspaces/${workspace._id}/members/${reviewerUser._id}`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const mem = await Membership.findOne({
        workspaceId: workspace._id,
        userId: reviewerUser._id,
      });
      expect(mem).toBeNull();
    });
  });

  // =========================================================================
  // BE 0.3: Workspace Invitations
  // =========================================================================
  describe("BE 0.3 — Invitations Lifecycle (POST, GET, resend, revoke)", () => {
    let inviteId: string;
    let inviteToken: string;

    it("POST /api/workspaces/:id/invitations sends invitation", async () => {
      const res = await request(app)
        .post(`/api/workspaces/${workspace._id}/invitations`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          email: "invitee@example.com",
          role: "editor",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.invitation).toBeDefined();
      expect(res.body.invitation.email).toBe("invitee@example.com");
      expect(res.body.invitation.role).toBe("editor");

      inviteId = res.body.invitation.id || res.body.invitation._id;
      inviteToken = res.body.invitation.token;
      expect(inviteToken).toBeDefined();
    });

    it("POST duplicate pending email updates existing invitation instead of duplicating", async () => {
      const initialCount = await Invitation.countDocuments({
        workspaceId: workspace._id,
        email: "invitee@example.com",
      });
      expect(initialCount).toBe(1);

      const res = await request(app)
        .post(`/api/workspaces/${workspace._id}/invitations`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          email: "invitee@example.com",
          role: "admin", // updated role
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body.success).toBe(true);
      expect(res.body.invitation.role).toBe("admin");

      const afterCount = await Invitation.countDocuments({
        workspaceId: workspace._id,
        email: "invitee@example.com",
      });
      expect(afterCount).toBe(1);
    });

    it("GET /api/workspaces/:id/invitations lists invitations", async () => {
      const res = await request(app)
        .get(`/api/workspaces/${workspace._id}/invitations`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.invitations)).toBe(true);
      expect(res.body.invitations.length).toBeGreaterThanOrEqual(1);
    });

    it("POST /api/workspaces/:id/invitations/:invitationId/resend preserves expiresAt", async () => {
      const invBefore = await Invitation.findById(inviteId);
      const originalExpiresAt = invBefore?.expiresAt?.toISOString();

      const res = await request(app)
        .post(`/api/workspaces/${workspace._id}/invitations/${inviteId}/resend`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const invAfter = await Invitation.findById(inviteId);
      expect(invAfter?.expiresAt?.toISOString()).toBe(originalExpiresAt);
    });

    it("POST /api/workspaces/:id/invitations/:invitationId/revoke marks status as revoked", async () => {
      const res = await request(app)
        .post(`/api/workspaces/${workspace._id}/invitations/${inviteId}/revoke`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.invitation.status).toBe("revoked");

      const invInDb = await Invitation.findById(inviteId);
      expect(invInDb?.status).toBe("revoked");
    });

    it("POST /api/invitations/:token/resend and DELETE /api/invitations/:token work with token directly", async () => {
      const resCreate = await request(app)
        .post(`/api/workspaces/${workspace._id}/invitations`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ email: "flat-test@example.com", role: "member" });

      const flatToken = resCreate.body.invitation.token;

      // Resend via flat token route
      const resResend = await request(app)
        .post(`/api/invitations/${flatToken}/resend`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(resResend.status).toBe(200);
      expect(resResend.body.success).toBe(true);

      // Revoke via flat token DELETE route
      const resRevoke = await request(app)
        .delete(`/api/invitations/${flatToken}`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(resRevoke.status).toBe(200);
      expect(resRevoke.body.success).toBe(true);

      const inDb = await Invitation.findOne({ token: flatToken });
      expect(inDb?.status).toBe("revoked");
    });
  });

  // =========================================================================
  // BE 0.4: Invite Acceptance Flow
  // =========================================================================
  describe("BE 0.4 — Invite Acceptance Flow", () => {
    let acceptInviteToken: string;

    beforeAll(async () => {
      // Create a fresh invitation for outsiderUser
      const res = await request(app)
        .post(`/api/workspaces/${workspace._id}/invitations`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          email: outsiderUser.email,
          role: "editor",
        });
      acceptInviteToken = res.body.invitation.token;
    });

    it("GET /api/invitations/:token works unauthenticated and returns exact preview shape", async () => {
      const res = await request(app).get(`/api/invitations/${acceptInviteToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify exact public preview contract
      expect(res.body.invitation).toBeDefined();
      const preview = res.body.invitation;
      expect(preview.workspaceName).toBe("Team Sprint 9 Workspace");
      expect(preview.inviterName).toBe("Owner User");
      expect(preview.role).toBe("editor");
      expect(preview.status).toBe("pending");
      expect(preview.invitedEmail).toBe(outsiderUser.email);
      expect(preview).toHaveProperty("callerEmailMatches");

      // Verify no sensitive internal secrets leaked
      expect(preview.token).toBeUndefined();
      expect(preview.__v).toBeUndefined();
    });

    it("POST /api/invitations/:token/accept rejects when caller email mismatches invitedEmail with 403 EMAIL_MISMATCH", async () => {
      // adminUser tries to accept invite targeted to outsiderUser
      const res = await request(app)
        .post(`/api/invitations/${acceptInviteToken}/accept`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code || res.body.error?.code).toBe("EMAIL_MISMATCH");
    });

    it("POST /api/invitations/:token/accept succeeds when caller email matches and creates membership", async () => {
      const res = await request(app)
        .post(`/api/invitations/${acceptInviteToken}/accept`)
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify membership exists
      const mem = await Membership.findOne({
        workspaceId: workspace._id,
        userId: outsiderUser._id,
      });
      expect(mem).toBeDefined();
      expect(mem?.role).toBe("editor");

      // Verify invitation status updated
      const inv = await Invitation.findOne({ token: acceptInviteToken });
      expect(inv?.status).toBe("accepted");
    });

    it("POST /api/invitations/:token/accept is idempotent for already accepted member", async () => {
      const res = await request(app)
        .post(`/api/invitations/${acceptInviteToken}/accept`)
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const memCount = await Membership.countDocuments({
        workspaceId: workspace._id,
        userId: outsiderUser._id,
      });
      expect(memCount).toBe(1);
    });
  });

  // =========================================================================
  // BE 0.5: Fine-Grained Role Matrix & Owner-Only Form Deletion
  // =========================================================================
  describe("BE 0.5 — Role Matrix & Owner-Only Form Deletion", () => {
    let formAlpha: any;

    beforeEach(async () => {
      formAlpha = await Form.create({
        title: "Matrix Test Form",
        workspaceId: workspace._id,
        createdBy: ownerUser._id,
        fields: [{ id: "f1", label: "Name", type: "short_text" }],
      });
    });

    it("Admin cannot delete workspace form (403 Forbidden)", async () => {
      const res = await request(app)
        .delete(`/api/forms/${formAlpha._id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);

      // Verify form still exists
      const f = await Form.findById(formAlpha._id);
      expect(f).toBeDefined();
    });

    it("Editor cannot delete workspace form (403 Forbidden)", async () => {
      const res = await request(app)
        .delete(`/api/forms/${formAlpha._id}`)
        .set("Authorization", `Bearer ${editorToken}`);

      expect(res.status).toBe(403);
    });

    it("Workspace Owner can delete workspace form (200 OK)", async () => {
      const res = await request(app)
        .delete(`/api/forms/${formAlpha._id}`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect([200, 204]).toContain(res.status);

      const f = await Form.findById(formAlpha._id);
      expect(f).toBeNull();
    });

    it("Editor can update form while Reviewer cannot", async () => {
      // Update by editor succeeds
      const resEditor = await request(app)
        .patch(`/api/forms/${formAlpha._id}`)
        .set("Authorization", `Bearer ${editorToken}`)
        .send({ title: "Updated by Editor" });

      expect(resEditor.status).toBe(200);

      // Add reviewer membership back to workspace
      await Membership.findOneAndUpdate(
        { workspaceId: workspace._id, userId: reviewerUser._id },
        { role: "reviewer" },
        { upsert: true }
      );

      // Update by reviewer fails with 403
      const resReviewer = await request(app)
        .patch(`/api/forms/${formAlpha._id}`)
        .set("Authorization", `Bearer ${reviewerToken}`)
        .send({ title: "Updated by Reviewer" });

      expect(resReviewer.status).toBe(403);
    });
  });

  // =========================================================================
  // BE 0.6 & BE 0.7: Per-Form Access Grants & Shared-With-Me & File Downloads
  // =========================================================================
  describe("BE 0.6 & BE 0.7 — Per-Form Grants, Shared-With-Me & File Access", () => {
    let personalForm: any;
    let personalResponse: any;
    let tempFilePath: string;

    beforeAll(async () => {
      // Personal form with workspaceId: null created by ownerUser
      personalForm = await Form.create({
        title: "Personal Grant Form",
        workspaceId: null,
        createdBy: ownerUser._id,
        fields: [{ id: "fileField", label: "Upload", type: "file_upload" }],
      });

      // Dummy file upload on disk for R3 testing
      const uploadDir = path.join(process.cwd(), "uploads", "responses");
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      personalResponse = await ResponseModel.create({
        formId: personalForm._id,
        answers: { fileField: "dummy.pdf" },
      });

      const responseFolder = path.join(uploadDir, personalResponse._id.toString());
      if (!fs.existsSync(responseFolder)) {
        fs.mkdirSync(responseFolder, { recursive: true });
      }
      tempFilePath = path.join(responseFolder, "test-doc.pdf");
      fs.writeFileSync(tempFilePath, "PDF content for testing grant access");

      await Upload.create({
        name: "test-doc.pdf",
        size: 100,
        type: "application/pdf",
        path: `responses/${personalResponse._id}/test-doc.pdf`,
        owner: ownerUser._id,
        isBranding: false,
      });
    });

    afterAll(() => {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    });

    it("Outsider initially cannot access personal form (403/404)", async () => {
      const res = await request(app)
        .get(`/api/forms/${personalForm._id}`)
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect([403, 404]).toContain(res.status);
    });

    it("POST /api/forms/:id/grants grants access to outsider", async () => {
      const res = await request(app)
        .post(`/api/forms/${personalForm._id}/grants`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          email: outsiderUser.email,
          accessLevel: "read",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.grant.userId).toBe(outsiderUser._id.toString());
      expect(res.body.grant.accessLevel).toBe("read");
      expect(res.body.grant.role).toBeDefined();
    });

    it("Grantee can now read form via GET /api/forms/:id", async () => {
      const res = await request(app)
        .get(`/api/forms/${personalForm._id}`)
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect(res.status).toBe(200);
      expect(res.body.form.title).toBe("Personal Grant Form");
    });

    it("Grantee can read form submissions via GET /api/forms/:id/submissions", async () => {
      const res = await request(app)
        .get(`/api/forms/${personalForm._id}/submissions`)
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("GET /api/shared-with-me returns forms shared with caller without leaking others", async () => {
      const res = await request(app)
        .get("/api/shared-with-me")
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.forms)).toBe(true);
      expect(res.body.forms.length).toBe(1);

      const shared = res.body.forms[0];
      expect(shared.id || shared._id).toBe(personalForm._id.toString());
      expect(shared.title).toBe("Personal Grant Form");
      expect(shared.accessLevel).toBe("read");
      expect(shared.sharedBy).toBeDefined();
      expect(shared.sharedByName).toBe("Owner User");
      expect(shared.sharedByEmail).toBe(ownerUser.email);
      expect(shared.sharedByUser).toBeDefined();
      expect(shared.sharedByUser.name).toBe("Owner User");

      // Check owner sees empty shared-with-me list since no one shared with them
      const ownerRes = await request(app)
        .get("/api/shared-with-me")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(ownerRes.body.forms.length).toBe(0);
    });

    it("GET /api/forms/:id/grants returns list of grants with email and user details", async () => {
      const res = await request(app)
        .get(`/api/forms/${personalForm._id}/grants`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.grants)).toBe(true);
      expect(res.body.grants.length).toBe(1);
      expect(res.body.grants[0].email).toBe(outsiderUser.email);
      expect(res.body.grants[0].accessLevel).toBe("read");
      expect(res.body.grants[0].user).toBeDefined();
      expect(res.body.grants[0].user.email).toBe(outsiderUser.email);
    });

    it("File download R3: Grantee can download attachment for Form A responses", async () => {
      const filePathParam = `responses/${personalResponse._id}/test-doc.pdf`;
      const res = await request(app)
        .get(`/api/upload/file/${filePathParam}`)
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe("PDF content for testing grant access");
    });

    it("File download R3: Outsider cannot download attachment for unauthorized Form B responses (403)", async () => {
      // Form B with separate response
      const formB = await Form.create({
        title: "Secret Form B",
        createdBy: ownerUser._id,
      });
      const responseB = await ResponseModel.create({
        formId: formB._id,
        answers: {},
      });

      const bDir = path.join(process.cwd(), "uploads", "responses", responseB._id.toString());
      if (!fs.existsSync(bDir)) {
        fs.mkdirSync(bDir, { recursive: true });
      }
      const bFile = path.join(bDir, "secret.pdf");
      fs.writeFileSync(bFile, "Top secret");

      await Upload.create({
        name: "secret.pdf",
        size: 100,
        type: "application/pdf",
        path: `responses/${responseB._id}/secret.pdf`,
        owner: ownerUser._id,
        isBranding: false,
      });

      try {
        const filePathParam = `responses/${responseB._id}/secret.pdf`;
        const res = await request(app)
          .get(`/api/upload/file/${filePathParam}`)
          .set("Authorization", `Bearer ${outsiderToken}`);

        expect(res.status).toBe(403);
      } finally {
        if (fs.existsSync(bFile)) {
          fs.unlinkSync(bFile);
        }
      }
    });

    it("DELETE /api/forms/:id/grants/:userId revokes form grant", async () => {
      const res = await request(app)
        .delete(`/api/forms/${personalForm._id}/grants/${outsiderUser._id}`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Now outsider gets 403 on the form
      const getRes = await request(app)
        .get(`/api/forms/${personalForm._id}`)
        .set("Authorization", `Bearer ${outsiderToken}`);
      expect([403, 404]).toContain(getRes.status);
    });
  });

  // =========================================================================
  // BE 0.8: Instant Session Invalidation
  // =========================================================================
  describe("BE 0.8 — Session Invalidation on Role Demote or Remove", () => {
    it("Demoting or removing a member immediately marks active sessions revoked and rejects replay with 401", async () => {
      // Create user for session test
      const sessionUser = await User.create({
        firebaseUid: "uid-session-test",
        fullName: "Session Test User",
        email: "session_test@test.com",
        role: "admin",
        status: "active",
        workspaceId: workspace._id,
      });

      await Membership.create({
        userId: sessionUser._id,
        workspaceId: workspace._id,
        role: "editor",
      });

      // Create active session in DB
      const activeSession = await SessionModel.create({
        userId: sessionUser._id,
        deviceLabel: "Chrome on Windows",
        userAgent: "Jest Test",
        ipHash: "mockiphash123456",
        lastActiveAt: new Date(),
      });

      const sessionToken = makeToken(sessionUser, activeSession._id.toString());

      // 1. Initial request with active session succeeds
      const checkRes1 = await request(app)
        .get(`/api/workspaces/${workspace._id}`)
        .set("Authorization", `Bearer ${sessionToken}`);
      expect(checkRes1.status).toBe(200);

      // 2. Owner changes sessionUser role from editor to reviewer
      const patchRes = await request(app)
        .patch(`/api/workspaces/${workspace._id}/members/${sessionUser._id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ role: "reviewer" });
      expect(patchRes.status).toBe(200);

      // 3. Verify session was marked revoked in DB
      const sessionInDb = await SessionModel.findById(activeSession._id);
      expect(sessionInDb?.revokedAt).not.toBeNull();

      // 4. Replaying request with that session's token now fails with 401
      const checkRes2 = await request(app)
        .get(`/api/workspaces/${workspace._id}`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(checkRes2.status).toBe(401);
      expect(checkRes2.body.message).toMatch(/revoked|expired/i);
    });
  });
});
