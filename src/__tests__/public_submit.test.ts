import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import path from "path";
import fs from "fs";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;
let tokenA: string;
let adminA: any;
let wsA: any;

// Set UPLOAD_DIR env for testing to avoid polluting the actual uploads directory
const testUploadDir = path.join(process.cwd(), "test_uploads_public_submit");
process.env.UPLOAD_DIR = testUploadDir;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";
  if (!fs.existsSync(testUploadDir)) {
    fs.mkdirSync(testUploadDir, { recursive: true });
  }
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  adminA = await User.create({
    firebaseUid: "uid-a",
    fullName: "Admin A",
    email: "admina@test.com",
    role: "admin",
  });
  wsA = await Workspace.create({ name: "Workspace A", owner: adminA._id });
  adminA.workspaceId = wsA._id;
  await adminA.save();

  tokenA = generateToken({ id: adminA._id.toString(), email: adminA.email, role: adminA.role });
}, 900000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
  // Cleanup the isolated test uploads dir
  if (fs.existsSync(testUploadDir)) {
    fs.rmSync(testUploadDir, { recursive: true, force: true });
  }
});

describe("POST /api/public/:slug/submit Integration Tests", () => {
  let slug: string;
  let formId: string;

  beforeEach(async () => {
    // Clear responses and uploads before each test
    await ResponseModel.deleteMany({});
    await Upload.deleteMany({});

    // Create a form with diverse field validations
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Submit Validation Test Form",
        fields: [
          { label: "EmailField", type: "email", required: true },
          { label: "NumberField", type: "number", required: false, min: 10, max: 20 },
          { label: "TextField", type: "short_text", required: false, maxLength: 5 },
          { label: "DateField", type: "date", required: false, minDate: "2026-01-01", maxDate: "2026-12-31" },
          { label: "FileField", type: "file_upload", required: false, maxFileSize: 1, allowedMimeTypes: ["image/png"] }
        ],
        settings: {
          honeypotEnabled: true
        }
      });
    expect(createRes.status).toBe(201);
    formId = createRes.body.form._id;

    // Publish the form
    const publishRes = await request(app)
      .post(`/api/forms/${formId}/publish`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(publishRes.status).toBe(200);
    slug = publishRes.body.slug;
  });

  it("should successfully submit valid inputs", async () => {
    const answers = {
      EmailField: "test@example.com",
      NumberField: 15,
      TextField: "hello",
      DateField: "2026-06-15"
    };

    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify(answers));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.submission).toBeDefined();

    // Verify stored in DB
    const dbSub = await ResponseModel.findOne({ formId });
    expect(dbSub).not.toBeNull();
    expect(dbSub?.answers.EmailField).toBe("test@example.com");
  });

  it("should successfully submit with array format answers (Shape A)", async () => {
    const formRecord = await Form.findById(formId);
    const emailField = formRecord?.fields.find(f => f.label === "EmailField");
    const numField = formRecord?.fields.find(f => f.label === "NumberField");

    const answersPayload = {
      answers: [
        { fieldId: emailField?.fieldId, value: "array@example.com" },
        { fieldId: numField?.fieldId, value: 18 }
      ]
    };

    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify(answersPayload));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const dbSub = await ResponseModel.findOne({ formId, "answers.EmailField": "array@example.com" });
    expect(dbSub).not.toBeNull();
  });

  it("should successfully submit using JSON request body (repro case 7)", async () => {
    const formRecord = await Form.findById(formId);
    const emailField = formRecord?.fields.find(f => f.label === "EmailField");

    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .set("Content-Type", "application/json")
      .send({
        answers: [
          { fieldId: emailField?.fieldId, value: "json-body@example.com" }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const dbSub = await ResponseModel.findOne({ formId, "answers.EmailField": "json-body@example.com" });
    expect(dbSub).not.toBeNull();
  });

  it("should successfully submit using raw multipart form parameters (repro case 4)", async () => {
    const formRecord = await Form.findById(formId);
    const emailField = formRecord?.fields.find(f => f.label === "EmailField");

    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field(emailField?.fieldId || "EmailField", "multipart-flat@example.com");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const dbSub = await ResponseModel.findOne({ formId, "answers.EmailField": "multipart-flat@example.com" });
    expect(dbSub).not.toBeNull();
  });

  it("should return 404 for submissions to an unknown slug", async () => {
    const res = await request(app)
      .post("/api/public/unknown-slug-1234/submit")
      .field("data", JSON.stringify({}));
    expect(res.status).toBe(404);
  });

  it("should silently bypass database insertion when honeypot field is filled", async () => {
    const answers = {
      EmailField: "test@example.com"
    };

    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify(answers))
      .field("_hp", "bot-detected");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify no response is written to database
    const dbSub = await ResponseModel.findOne({ formId });
    expect(dbSub).toBeNull();
  });

  it("should reject submission when a required field is missing", async () => {
    const answers = {
      NumberField: 15
    };
    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify(answers));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain("required");
  });

  it("should reject submission on invalid email format", async () => {
    const answers = {
      EmailField: "invalid-email"
    };
    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify(answers));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain("valid email address");
  });

  it("should reject submission if number is below min or above max", async () => {
    // Test below min
    let res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify({ EmailField: "test@example.com", NumberField: 5 }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain("must be at least 10");

    // Test above max
    res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify({ EmailField: "test@example.com", NumberField: 25 }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain("cannot exceed 20");
  });

  it("should reject submission if text length exceeds maxLength", async () => {
    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify({ EmailField: "test@example.com", TextField: "too-long-text" }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain("cannot exceed 5 characters");
  });

  it("should reject submission if date violates minDate or maxDate", async () => {
    // Too early
    let res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify({ EmailField: "test@example.com", DateField: "2025-12-31" }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain("date cannot be earlier than 2026-01-01");

    // Too late
    res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify({ EmailField: "test@example.com", DateField: "2027-01-01" }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain("date cannot be later than 2026-12-31");
  });

  it("should successfully validate and upload file matching constraints", async () => {
    const mockFileContent = Buffer.from("fake-image-bytes");
    const answers = {
      EmailField: "test@example.com"
    };

    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify(answers))
      .attach("FileField", mockFileContent, { filename: "test-upload.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify upload document was created with workspace owner as the owner
    const uploadMeta = await Upload.findOne({ isBranding: false });
    expect(uploadMeta).not.toBeNull();
    expect(uploadMeta?.owner.toString()).toBe(adminA._id.toString());
    expect(uploadMeta?.name).toBe("test-upload.png");

    // Verify response answers contains the file url and linked fieldId key
    const dbSub = await ResponseModel.findOne({ formId });
    expect(dbSub?.answers.FileField).toBeDefined();
    expect(dbSub?.answers.FileField.fileName).toContain("/api/upload/file/");

    const formRecord = await Form.findById(formId);
    const fileField = formRecord?.fields.find(f => f.type === "file_upload");
    expect(fileField).toBeDefined();
    if (fileField && fileField.fieldId) {
      expect(dbSub?.answers[fileField.fieldId] || dbSub?.answers.FileField).toBeDefined();
    }

    // Cleanup physical test upload
    if (uploadMeta) {
      const filePath = path.join(testUploadDir, uploadMeta.path);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }
  });

  it("should reject file exceeding maxFileSize limit", async () => {
    const largeFile = Buffer.alloc(2 * 1024 * 1024); // 2MB
    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify({ EmailField: "test@example.com" }))
      .attach("FileField", largeFile, { filename: "test-upload-large.png", contentType: "image/png" });

    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain("exceeds the limit of 1 MB");
  });

  it("should reject file with unallowed MIME types", async () => {
    const mockFileContent = Buffer.from("pdf-bytes");
    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify({ EmailField: "test@example.com" }))
      .attach("FileField", mockFileContent, { filename: "test-upload.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain("file type \"application/pdf\" is not allowed");
  });

  it("should skip validation for conditionally hidden fields based on logic rules", async () => {
    // 1. Create a form with a logic rule
    const formWithRules = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Conditional Logic Test Form",
        fields: [
          { fieldId: "email-1", label: "EmailField", type: "email", required: true },
          { 
            fieldId: "text-1", 
            label: "TextField", 
            type: "short_text", 
            required: true
          }
        ]
      });
    expect(formWithRules.status).toBe(201);
    const condFormId = formWithRules.body.form._id;

    // Patch logic rule on EmailField to hide TextField when EmailField is hide@test.com
    const patchRes = await request(app)
      .patch(`/api/forms/${condFormId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        fields: [
          { 
            fieldId: "email-1", 
            label: "EmailField", 
            type: "email", 
            required: true,
            logicRules: [
              { targetFieldId: "text-1", action: "show", value: "show@test.com" }
            ]
          },
          { 
            fieldId: "text-1", 
            label: "TextField", 
            type: "short_text", 
            required: true
          }
        ]
      });
    expect(patchRes.status).toBe(200);

    // Publish the form
    const pubRes = await request(app)
      .post(`/api/forms/${condFormId}/publish`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(pubRes.status).toBe(200);
    const condSlug = pubRes.body.slug;

    // Test case A: EmailField is "hide@test.com" (not "show@test.com"). TextField is hidden by default, so OMITTING it should succeed!
    const resA = await request(app)
      .post(`/api/public/${condSlug}/submit`)
      .field("data", JSON.stringify({ EmailField: "hide@test.com" }));
    expect(resA.status).toBe(200);
    expect(resA.body.success).toBe(true);

    // Test case B: EmailField is "show@test.com". TextField is shown, so OMITTING it should FAIL (422)!
    const resB = await request(app)
      .post(`/api/public/${condSlug}/submit`)
      .field("data", JSON.stringify({ EmailField: "show@test.com" }));
    expect(resB.status).toBe(422);
    expect(resB.body.errors[0].message).toContain("required");
  });
});
