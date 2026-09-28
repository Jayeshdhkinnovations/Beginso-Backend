import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";
import Template from "../models/Template";
import { generateToken } from "../utils/generateToken";
import fs from "fs";
import path from "path";

let mongoServer: MongoMemoryServer;
let tokenA: string;
let tokenB: string;
let adminA: any;
let adminB: any;
let wsA: any;
let wsB: any;

process.env.JWT_SECRET = "test-secret-key-regression-1234567890-test-key-long-enough";
const uploadDir = path.join(process.cwd(), "test_regression_uploads");
process.env.UPLOAD_DIR = uploadDir;

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // Create two users and workspaces
  adminA = await User.create({
    firebaseUid: "uid-a",
    fullName: "Admin A",
    email: "admina@test.com",
    role: "admin",
  });
  wsA = await Workspace.create({ name: "Workspace A", owner: adminA._id });
  adminA.workspaceId = wsA._id;
  await adminA.save();

  adminB = await User.create({
    firebaseUid: "uid-b",
    fullName: "Admin B",
    email: "adminb@test.com",
    role: "admin",
  });
  wsB = await Workspace.create({ name: "Workspace B", owner: adminB._id });
  adminB.workspaceId = wsB._id;
  await adminB.save();

  tokenA = generateToken({ id: adminA._id.toString(), email: adminA.email, role: adminA.role });
  tokenB = generateToken({ id: adminB._id.toString(), email: adminB.email, role: adminB.role });

  // Seed templates
  const templates = [
    { name: "T1", category: "G", theme: "light", isActive: true, fields: [] },
    { name: "T2", category: "G", theme: "light", isActive: true, fields: [] },
    { name: "T3", category: "G", theme: "light", isActive: true, fields: [] },
    { name: "T4", category: "G", theme: "light", isActive: true, fields: [] },
    { name: "T5", category: "G", theme: "light", isActive: true, fields: [] },
  ];
  await Template.insertMany(templates);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
});

describe("Bruno Regression Route Pass & Forms Lifecycle Tests", () => {
  
  // 1. Test publish generates a unique slug and sets publishedAt
  it("should generate a unique slug and set publishedAt when publishing a form", async () => {
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Publish Test Form",
        fields: [{ label: "Email", type: "email", required: true }],
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.form.pages).toBeDefined();
    expect(createRes.body.form.pages.length).toBe(1);
    expect(createRes.body.form.pages[0].title).toBe("Publish Test Form");
    expect(createRes.body.form.fields[0].pageId).toBe(createRes.body.form.pages[0].id);

    const formId = createRes.body.form._id;

    const publishRes = await request(app)
      .post(`/api/forms/${formId}/publish`)
      .set("Authorization", `Bearer ${tokenA}`);
    
    expect(publishRes.status).toBe(200);
    expect(publishRes.body.success).toBe(true);
    expect(publishRes.body.status).toBe("published");
    expect(publishRes.body.slug).toBeDefined();
    expect(publishRes.body.publishedAt).toBeDefined();
  });

  // 2. Test publishing a zero-field or zero-option form is rejected (400)
  it("should reject publishing a zero-field form with 400", async () => {
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Empty Form",
        fields: [],
      });
    expect(createRes.status).toBe(201);
    const formId = createRes.body.form._id;

    const publishRes = await request(app)
      .post(`/api/forms/${formId}/publish`)
      .set("Authorization", `Bearer ${tokenA}`);
    
    expect(publishRes.status).toBe(400);
    expect(publishRes.body.success).toBe(false);
    expect(publishRes.body.error.message).toContain("at least one field");
  });

  it("should reject publishing a choice field form with zero options with 400", async () => {
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "No-Option Choice Form",
        fields: [{ label: "Select One", type: "dropdown", required: true, options: [] }],
      });
    expect(createRes.status).toBe(400);
    expect(createRes.body.success).toBe(false);
    expect(createRes.body.message).toContain("Validation failed");
  });

  // 3. Test close sets status to closed
  it("should set status to closed when closing a form", async () => {
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Close Test Form",
        fields: [{ label: "Name", type: "short_text" }],
      });
    const formId = createRes.body.form._id;

    const closeRes = await request(app)
      .post(`/api/forms/${formId}/close`)
      .set("Authorization", `Bearer ${tokenA}`);
    
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.success).toBe(true);
    expect(closeRes.body.status).toBe("closed");
  });

  // 4. Test the delete cascade removes responses, file metadata, and files on disk
  it("should cascade-delete responses, file metadata, and physical disk files", async () => {
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Cascade Delete Form",
        fields: [{ label: "CV", type: "file_upload", required: false }],
      });
    const formId = createRes.body.form._id;

    // Create fake disk file and upload document in DB
    const filename = `regression-file-${Date.now()}.png`;
    const filepath = path.join(uploadDir, filename);
    fs.writeFileSync(filepath, "content");

    const uploadRecord = await Upload.create({
      name: "cv.png",
      size: 10,
      type: "image/png",
      path: filename,
      owner: adminA._id,
    });

    // Submit submission
    await ResponseModel.create({
      formId: new mongoose.Types.ObjectId(formId),
      answers: {
        CV: {
          fileName: filename,
          fileSize: 10,
          mimeType: "image/png",
        },
      },
    });

    // Verify database and disk setups
    expect(await ResponseModel.findOne({ formId })).not.toBeNull();
    expect(await Upload.findById(uploadRecord._id)).not.toBeNull();
    expect(fs.existsSync(filepath)).toBe(true);

    // Call DELETE API
    const deleteRes = await request(app)
      .delete(`/api/forms/${formId}`)
      .set("Authorization", `Bearer ${tokenA}`);
    
    expect(deleteRes.status).toBe(204);

    // Verify cascade deletions completed successfully
    expect(await Form.findById(formId)).toBeNull();
    expect(await ResponseModel.findOne({ formId })).toBeNull();
    expect(await Upload.findById(uploadRecord._id)).toBeNull();
    expect(fs.existsSync(filepath)).toBe(false);
  });

  // 5. Test POST /api/upload with a valid image (returns backend-served URL + metadata)
  it("should upload a valid image and return backend-served URL + metadata", async () => {
    const res = await request(app)
      .post("/api/upload")
      .set("Authorization", `Bearer ${tokenA}`)
      .attach("logo", Buffer.from("fake-png-headers-and-data"), "test_logo.png");

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toContain("/api/upload/file/");
    expect(res.body.metadata.name).toBe("test_logo.png");
    expect(res.body.metadata.size).toBeDefined();
    expect(res.body.metadata.type).toBe("image/png");
    expect(res.body.metadata.id).toBeDefined();
  });

  // 6. Test POST /api/upload rejects a non-image type (400) and leaves no temp file
  it("should reject non-image file types for branding uploads with 400", async () => {
    const res = await request(app)
      .post("/api/upload?type=branding")
      .set("Authorization", `Bearer ${tokenA}`)
      .attach("file", Buffer.from("pdf content"), "doc.pdf");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("must be image files");

    // Temp file checks
    const files = fs.readdirSync(uploadDir);
    const pdfs = files.filter(f => f.endsWith(".pdf"));
    expect(pdfs.length).toBe(0);
  });

  // 7. Test the file-serving route streams the stored file for preview/download
  it("should stream stored files on GET /api/upload/file/:filename", async () => {
    const uploadRes = await request(app)
      .post("/api/upload")
      .set("Authorization", `Bearer ${tokenA}`)
      .attach("logo", Buffer.from("fake-image-bytes"), "image.jpg");
    
    // Clients use the full path the upload endpoint returned, not just its last segment.
    const storedPath = new URL(uploadRes.body.url).pathname.replace("/api/upload/file/", "");

    const streamRes = await request(app)
      .get(`/api/upload/file/${storedPath}`);
    
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers["content-type"]).toBe("image/jpeg");
    expect(streamRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(streamRes.body.toString()).toBe("fake-image-bytes");

    // A bare filename must not resolve to a structured path (that lookup was a cross-tenant leak).
    const bare = await request(app).get(`/api/upload/file/${path.basename(storedPath)}`);
    expect(bare.status).toBe(404);
  });

  // 8. Test GET /api/templates returns 5+ active templates
  it("should return 5+ active templates on GET /api/templates", async () => {
    const res = await request(app)
      .get("/api/templates")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(5);
  });

  // 9. Test POST /api/templates/:id/use creates a workspace-scoped form
  it("should create a workspace-scoped form from a template ID", async () => {
    const templatesList = await Template.find({ isActive: true });
    const templateId = templatesList[0]._id.toString();

    const useRes = await request(app)
      .post(`/api/templates/${templateId}/use`)
      .set("Authorization", `Bearer ${tokenA}`);
    
    expect(useRes.status).toBe(201);
    expect(useRes.body.success).toBe(true);
    expect(useRes.body.data.workspaceId).toBe(wsA._id.toString());
  });

  // 10. Run the cross-workspace 403 test on every lifecycle route
  it("should return 403 on cross-workspace attempts for all lifecycle routes", async () => {
    const formA = await Form.create({
      title: "Workspace A Form",
      workspaceId: wsA._id,
      fields: [{ label: "Name", type: "short_text" }],
      status: "draft",
    });

    const routes = [
      { method: "get", path: `/api/forms/${formA._id}` },
      { method: "put", path: `/api/forms/${formA._id}`, body: { title: "Hacked" } },
      { method: "patch", path: `/api/forms/${formA._id}`, body: { title: "Hacked" } },
      { method: "post", path: `/api/forms/${formA._id}/publish` },
      { method: "post", path: `/api/forms/${formA._id}/close` },
      { method: "post", path: `/api/forms/${formA._id}/duplicate` },
      { method: "delete", path: `/api/forms/${formA._id}` },
    ];

    for (const r of routes) {
      let res: any;
      if (r.method === "get") {
        res = await request(app).get(r.path).set("Authorization", `Bearer ${tokenB}`);
      } else if (r.method === "put") {
        res = await request(app).put(r.path).set("Authorization", `Bearer ${tokenB}`).send(r.body);
      } else if (r.method === "patch") {
        res = await request(app).patch(r.path).set("Authorization", `Bearer ${tokenB}`).send(r.body);
      } else if (r.method === "post") {
        res = await request(app).post(r.path).set("Authorization", `Bearer ${tokenB}`);
      } else if (r.method === "delete") {
        res = await request(app).delete(r.path).set("Authorization", `Bearer ${tokenB}`);
      }

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain("Forbidden");
    }
  });

  // 11. Run the logic-rule and constraint 400 tests
  it("should reject invalid logic rules with 400 Bad Request", async () => {
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Invalid Logic Rule Form",
        fields: [
          {
            fieldId: "f1",
            label: "Conditional",
            type: "short_text",
            required: true,
            logicRules: [
              {
                targetFieldId: "f1", // Self-referencing target
                operator: "equals",
                value: "hello",
                action: "hide",
              },
            ],
          },
        ],
      });
    
    expect(createRes.status).toBe(400);
    expect(createRes.body.success).toBe(false);
    expect(createRes.body.error.message).toContain("cannot target itself");
  });

  // 12. Test layout settings update
  it("should accept valid layout settings (single_column, two_column, compact)", async () => {
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Layout Test Form",
        fields: [{ label: "Email", type: "email" }],
      });
    expect(createRes.status).toBe(201);
    const formId = createRes.body.form._id;

    // PATCH with compact layout
    const patchRes = await request(app)
      .patch(`/api/forms/${formId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        settings: {
          layout: "compact",
        },
      });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.form.settings.layout).toBe("compact");
  });

  // 13. Test multi-page validation errors
  it("should reject pageId referencing non-existent page", async () => {
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Page Reference Test Form",
        pages: [{ id: "page-1", order: 0, title: "Page 1" }],
        fields: [
          {
            label: "Email",
            type: "email",
            pageId: "page-2", // Non-existent page
          },
        ],
      });
    expect(createRes.status).toBe(400);
    expect(createRes.body.success).toBe(false);
  });

  it("should reject patching a form with empty pages list", async () => {
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Empty Pages Test Form",
        fields: [{ label: "Email", type: "email" }],
      });
    expect(createRes.status).toBe(201);
    const formId = createRes.body.form._id;

    const patchRes = await request(app)
      .patch(`/api/forms/${formId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        pages: [], // Empty pages array
      });
    expect(patchRes.status).toBe(400);
    expect(patchRes.body.success).toBe(false);
  });
});
