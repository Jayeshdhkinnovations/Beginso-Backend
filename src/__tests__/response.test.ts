import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import fs from "fs";
import path from "path";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";
import { generateToken } from "../utils/generateToken";
import { getUploadDir } from "../controllers/upload.controller";

let mongoServer: MongoMemoryServer;
let userAToken: string;
let userBToken: string;
let userAId: string;
let userBId: string;
let workspaceAId: string;
let workspaceBId: string;
let formAId: string;
let formBId: string;
let responseA1Id: string;
let responseB1Id: string;
let fileMetadataId: string;
let physicalFilePath: string;

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  // User A setup
  const userA = await User.create({
    firebaseUid: "user-a-uid-responses",
    fullName: "User A",
    email: "usera-resp@test.com",
    role: "admin",
  });
  userAId = userA._id.toString();

  const wsA = await Workspace.create({
    name: "Workspace A",
    owner: userA._id,
  });
  workspaceAId = wsA._id.toString();
  userA.workspaceId = wsA._id as any;
  await userA.save();

  userAToken = generateToken({
    id: userAId,
    email: userA.email,
    role: userA.role,
  });

  // User B setup
  const userB = await User.create({
    firebaseUid: "user-b-uid-responses",
    fullName: "User B",
    email: "userb-resp@test.com",
    role: "admin",
  });
  userBId = userB._id.toString();

  const wsB = await Workspace.create({
    name: "Workspace B",
    owner: userB._id,
  });
  workspaceBId = wsB._id.toString();
  userB.workspaceId = wsB._id as any;
  await userB.save();

  userBToken = generateToken({
    id: userBId,
    email: userB.email,
    role: userB.role,
  });

  // Create Form A for User A
  const formA = await Form.create({
    title: "Form A",
    workspaceId: new mongoose.Types.ObjectId(workspaceAId),
    status: "published",
    publishedSlug: "form-a-slug",
    fields: [
      { fieldId: "f1", label: "Email", type: "email", required: false },
      { fieldId: "f2", label: "Feedback", type: "short_text", required: false },
    ],
  });
  formAId = (formA._id as mongoose.Types.ObjectId).toString();

  // Create Form B for User B
  const formB = await Form.create({
    title: "Form B",
    workspaceId: new mongoose.Types.ObjectId(workspaceBId),
    status: "published",
    publishedSlug: "form-b-slug",
    fields: [
      { fieldId: "f3", label: "Name", type: "short_text", required: false },
    ],
  });
  formBId = (formB._id as mongoose.Types.ObjectId).toString();

  // Seed responses for Form A
  const now = Date.now();
  const respA1 = await ResponseModel.create({
    formId: formA._id,
    answers: { Email: "alice@example.com", Feedback: "Great platform" },
    status: "new",
    submittedAt: new Date(now - 3000),
    ipHash: "a1b2c3d4e5f67890",
  });
  responseA1Id = respA1._id.toString();

  await ResponseModel.create({
    formId: formA._id,
    answers: { Email: "bob@example.com", Feedback: "Needs improvement" },
    status: "in_progress",
    submittedAt: new Date(now - 2000),
    ipHash: "1234567890abcdef",
  });

  await ResponseModel.create({
    formId: formA._id,
    answers: { Email: "charlie@example.com", Feedback: "Excellent customer service" },
    status: "completed",
    submittedAt: new Date(now - 1000),
    ipHash: "fedcba0987654321",
  });

  // Create mock file on disk for responseA1Id
  const uploadDir = getUploadDir();
  const relPath = `${userAId}/${formAId}/responses/${responseA1Id}/attached_doc.pdf`;
  physicalFilePath = path.join(uploadDir, relPath);
  fs.mkdirSync(path.dirname(physicalFilePath), { recursive: true });
  fs.writeFileSync(physicalFilePath, "fake pdf content for testing");

  const uploadDoc = await Upload.create({
    name: "attached_doc.pdf",
    size: 1024,
    type: "application/pdf",
    path: relPath,
    owner: new mongoose.Types.ObjectId(userAId),
    isBranding: false,
  });
  fileMetadataId = uploadDoc._id.toString();

  // Seed response for Form B
  const respB1 = await ResponseModel.create({
    formId: formB._id,
    answers: { Name: "David" },
    status: "completed",
    submittedAt: new Date(now),
    ipHash: "9999888877776666",
  });
  responseB1Id = respB1._id.toString();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
  const uploadDir = getUploadDir();
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
});

describe("GET /api/responses (Listing)", () => {
  it("should fetch responses for a workspace form with pagination and submittedAt desc order", async () => {
    const res = await request(app)
      .get(`/api/responses?formId=${formAId}&page=1&limit=2`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.length).toBe(2);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
    expect(res.body.totalPages).toBe(2);

    const timestamps = res.body.data.map((r: any) => new Date(r.submittedAt).getTime());
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);
  });

  it("should cap limit at 50 per page max", async () => {
    const res = await request(app)
      .get(`/api/responses?formId=${formAId}&limit=200`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
  });

  it("should filter responses by status", async () => {
    const res = await request(app)
      .get(`/api/responses?formId=${formAId}&status=completed`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].status).toBe("completed");
    expect(res.body.data[0].answers.Email).toBe("charlie@example.com");
  });

  it("should search against answers content", async () => {
    const res = await request(app)
      .get(`/api/responses?formId=${formAId}&search=customer`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].answers.Email).toBe("charlie@example.com");
  });

  it("should return 403 when formId belongs to another workspace", async () => {
    const res = await request(app)
      .get(`/api/responses?formId=${formBId}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Forbidden");
  });

  it("should return 404 when formId does not exist", async () => {
    const nonExistentId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .get(`/api/responses?formId=${nonExistentId}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Form not found");
  });
});

describe("GET /api/responses/stats (Summary Cards)", () => {
  it("should return correct total, new, in_progress, and completed counts for a form", async () => {
    const res = await request(app)
      .get(`/api/responses/stats?formId=${formAId}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.total).toBe(3);
    expect(res.body.stats.new).toBe(1);
    expect(res.body.stats.in_progress).toBe(1);
    expect(res.body.stats.completed).toBe(1);
    expect(res.body.stats.total).toBe(
      res.body.stats.new + res.body.stats.in_progress + res.body.stats.completed
    );
  });

  it("should return 403 when requesting stats for formId belonging to another workspace", async () => {
    const res = await request(app)
      .get(`/api/responses/stats?formId=${formBId}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Forbidden");
  });

  it("should return 404 when formId does not exist", async () => {
    const nonExistentId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .get(`/api/responses/stats?formId=${nonExistentId}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe("GET /api/responses/:id (Detail & File Joining)", () => {
  it("should return full response with joined response_files metadata without exposing internal disk path", async () => {
    const res = await request(app)
      .get(`/api/responses/${responseA1Id}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.response._id).toBe(responseA1Id);
    expect(res.body.response.formId).toBe(formAId);
    expect(res.body.response.status).toBe("new");
    expect(res.body.response.response_files).toBeDefined();
    expect(res.body.response.response_files.length).toBe(1);

    const fileMeta = res.body.response.response_files[0];
    expect(fileMeta.id).toBe(fileMetadataId);
    expect(fileMeta.name).toBe("attached_doc.pdf");
    expect(fileMeta.size).toBe(1024);
    expect(fileMeta.type).toBe("application/pdf");
    expect(fileMeta.url).toContain("/api/upload/file/");
    // Assert internal disk path is NEVER exposed in metadata
    expect((fileMeta as any).path).toBeUndefined();
    expect((fileMeta as any).r2Key).toBeUndefined();
  });

  it("should return 403 when trying to access response from another workspace", async () => {
    const res = await request(app)
      .get(`/api/responses/${responseB1Id}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("should return 404 when response does not exist", async () => {
    const nonExistentId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .get(`/api/responses/${nonExistentId}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe("PATCH /api/responses/:id (Status Update)", () => {
  it("should update response status to 'in_progress'", async () => {
    const res = await request(app)
      .patch(`/api/responses/${responseA1Id}`)
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.response.status).toBe("in_progress");

    const updated = await ResponseModel.findById(responseA1Id);
    expect(updated?.status).toBe("in_progress");
  });

  it("should revert response status from 'completed' back to 'new'", async () => {
    // 1. Set to completed
    await request(app)
      .patch(`/api/responses/${responseA1Id}`)
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ status: "completed" });

    // 2. Revert back to new
    const res = await request(app)
      .patch(`/api/responses/${responseA1Id}`)
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ status: "new" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.response.status).toBe("new");

    const inDb = await ResponseModel.findById(responseA1Id);
    expect(inDb?.status).toBe("new");
  });

  it("should revert response status from 'in_progress' back to 'new'", async () => {
    // 1. Set to in_progress
    await request(app)
      .patch(`/api/responses/${responseA1Id}`)
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ status: "in_progress" });

    // 2. Revert back to new
    const res = await request(app)
      .patch(`/api/responses/${responseA1Id}`)
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ status: "new" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.response.status).toBe("new");
  });

  it("should reject invalid status with 422 Unprocessable Entity", async () => {
    const res = await request(app)
      .patch(`/api/responses/${responseA1Id}`)
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ status: "invalid_status_enum" });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Validation failed");
    expect(res.body.errors).toBeDefined();
  });

  it("should update response status via PUT method (compatibility)", async () => {
    const res = await request(app)
      .put(`/api/responses/${responseA1Id}`)
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.response.status).toBe("in_progress");
    expect(res.body.data.status).toBe("in_progress");
  });

  it("should reject status aliases like 'pending' with 422", async () => {
    const res = await request(app)
      .patch(`/api/responses/${responseA1Id}`)
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ status: "pending" });

    expect(res.status).toBe(422);
  });

  it("should return 403 on cross-workspace PATCH attempt", async () => {
    const res = await request(app)
      .patch(`/api/responses/${responseB1Id}`)
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ status: "completed" });

    expect(res.status).toBe(403);
  });
});

describe("GET /api/responses/:id/file/:fileId (File URL Fetch)", () => {
  it("should return safe tokenized backend URL for response file without raw disk path", async () => {
    const res = await request(app)
      .get(`/api/responses/${responseA1Id}/file/${fileMetadataId}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toContain("/api/upload/file/");
    expect(res.body.url).not.toContain("C:");
  });

  it("should return 404 if file does not belong to the response", async () => {
    const nonExistentFileId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .get(`/api/responses/${responseA1Id}/file/${nonExistentFileId}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(404);
  });

  it("should return 403 if accessing file for another workspace's response", async () => {
    const res = await request(app)
      .get(`/api/responses/${responseB1Id}/file/${fileMetadataId}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/responses/:id (Cascade Deletion & Sweep)", () => {
  it("should return 403 on cross-workspace DELETE attempt", async () => {
    const res = await request(app)
      .delete(`/api/responses/${responseB1Id}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(403);
  });

  it("should cascade delete response, metadata, and physical disk files returning 204 No Content", async () => {
    expect(fs.existsSync(physicalFilePath)).toBe(true);

    const res = await request(app)
      .delete(`/api/responses/${responseA1Id}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(204);

    // Sprint 13: the delete is a move to Trash - the row and its file are kept...
    expect((await ResponseModel.findById(responseA1Id))!.deletedAt).toBeTruthy();
    expect(fs.existsSync(physicalFilePath)).toBe(true);

    // ...and a permanent delete from Trash removes the row, the metadata and the file.
    const purge = await request(app)
      .delete(`/api/trash/response/${responseA1Id}`)
      .set("Authorization", `Bearer ${userAToken}`)
      .send({ confirm: "DELETE" });
    expect(purge.status).toBe(200);

    // Verify response is deleted from DB
    const dbResponse = await ResponseModel.findById(responseA1Id);
    expect(dbResponse).toBeNull();

    // Verify Upload metadata record is deleted from DB
    const dbUpload = await Upload.findById(fileMetadataId);
    expect(dbUpload).toBeNull();

    // Verify physical file was unlinked from disk (no orphaned files remaining)
    expect(fs.existsSync(physicalFilePath)).toBe(false);
  });
});

describe("Security & Injection Safety", () => {
  it("should safely sanitize search inputs containing regex / injection special characters", async () => {

    const res = await request(app)
      .get(`/api/responses?formId=${formAId}&search=${encodeURIComponent(".*+?^${}()|[]\\")}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it("should never return another workspace's responses when formId parameter is missing or spoofed", async () => {
    const res = await request(app)
      .get(`/api/responses?formId=${formBId}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  // Sprint 12 (30 Sep 2026), real bug found in manual QA: a user who is also a member/owner of a
  // workspace (userA owns Workspace A, same as every other test in this file) saw that
  // workspace's responses under the Personal shell, because sending no `x-workspace-slug` header
  // at all was indistinguishable, to `requirePermission`, from "resolve my default workspace" —
  // the exact silent fallback design.md's OQ-1 named as the risk to avoid. The frontend fix sends
  // an explicit `x-workspace-slug: personal` header; this is the backend half: that header must
  // list ONLY the caller's true personal-space responses (forms with no workspaceId), never
  // Workspace A's, even though userA owns Workspace A.
  it("Personal shell (x-workspace-slug: personal) never returns the caller's workspace responses", async () => {
    const personalForm = await Form.create({
      title: "Personal form (no workspace)",
      createdBy: userAId,
      workspaceId: null,
      fields: [],
      status: "published",
    });
    const personalResponse = await ResponseModel.create({
      formId: personalForm._id,
      answers: { email: "solo@test.com" },
      status: "new",
    });

    const res = await request(app)
      .get(`/api/responses`)
      .set("Authorization", `Bearer ${userAToken}`)
      .set("x-workspace-slug", "personal");

    expect(res.status).toBe(200);
    const ids = res.body.data.map((r: any) => r._id);
    expect(ids).toContain(personalResponse._id.toString());
    expect(ids).not.toContain(responseA1Id);

    const statsRes = await request(app)
      .get(`/api/responses/stats`)
      .set("Authorization", `Bearer ${userAToken}`)
      .set("x-workspace-slug", "personal");
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.total).toBe(1);
  });

  // Real bug (1 Oct 2026): changing the Stage of a PERSONAL response returned 400 "Invalid
  // identifier". updateResponseStage checked ownership with `Form.exists({ workspaceId })`, and a
  // personal request's workspaceId is "" — which Mongoose can't cast to an ObjectId — so it threw a
  // CastError before ever reaching the personal-space branch. It now uses the same ownership rule
  // as every other response-scoped method (createdBy for a form with no workspace).
  it("lets the owner change the stage of a personal response, and refuses anyone else", async () => {
    const personalForm = await Form.create({
      title: "Personal form for stage change",
      createdBy: userAId,
      workspaceId: null,
      fields: [],
      status: "published",
    });
    const personalResponse = await ResponseModel.create({
      formId: personalForm._id,
      answers: { email: "stage@test.com" },
      status: "new",
    });

    const ok = await request(app)
      .patch(`/api/responses/${personalResponse._id}`)
      .set("Authorization", `Bearer ${userAToken}`)
      .set("x-workspace-slug", "personal")
      .send({ status: "in_progress" });

    expect(ok.status).toBe(200);
    expect(ok.body.response.status).toBe("in_progress");
    const stored = await ResponseModel.findById(personalResponse._id).lean();
    expect(stored?.status).toBe("in_progress");

    const forbidden = await request(app)
      .patch(`/api/responses/${personalResponse._id}`)
      .set("Authorization", `Bearer ${userBToken}`)
      .set("x-workspace-slug", "personal")
      .send({ status: "completed" });

    expect(forbidden.status).not.toBe(200);
    const unchanged = await ResponseModel.findById(personalResponse._id).lean();
    expect(unchanged?.status).toBe("in_progress");
  });
});

describe("Compound Index Verification", () => {
  it("should verify compound index exists on ResponseModel", async () => {
    const indexes = ResponseModel.schema.indexes();
    const hasCompoundIndex = indexes.some((item: any) => {
      const indexSpec = item[0];
      return (
        indexSpec &&
        indexSpec.formId === 1 &&
        indexSpec.submittedAt === -1
      );
    });
    expect(hasCompoundIndex).toBe(true);
  });
});
