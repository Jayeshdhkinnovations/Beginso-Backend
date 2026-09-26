import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import Template from "../models/Template";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;
let authToken: string;
let mockUserId: string;
let mockWorkspaceId: string;
let activeTemplateId: string;
let inactiveTemplateId: string;

process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  // Create a mock user & workspace
  const user = await User.create({
    firebaseUid: "template-test-uid",
    fullName: "Template Tester",
    email: "templatetester@test.com",
    role: "admin",
  });
  mockUserId = user._id.toString();

  const workspace = await Workspace.create({
    name: "Tester's Workspace",
    owner: user._id,
  });
  mockWorkspaceId = workspace._id.toString();

  user.workspaceId = workspace._id as any;
  await user.save();

  // Generate JWT token
  authToken = generateToken({
    id: mockUserId,
    email: user.email,
    role: user.role,
  });

  // Seed two templates (one active, one inactive)
  const activeT = await Template.create({
    name: "Active Test Template",
    category: "Test",
    theme: "classic-light",
    isActive: true,
    fields: [
      { label: "Full Name", type: "short_text", required: true },
      { label: "Email Address", type: "email", required: true },
    ],
  });
  activeTemplateId = activeT._id.toString();

  const inactiveT = await Template.create({
    name: "Inactive Test Template",
    category: "Test",
    theme: "classic-dark",
    isActive: false,
    fields: [
      { label: "Phone Number", type: "phone", required: false },
    ],
  });
  inactiveTemplateId = inactiveT._id.toString();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe("Templates API Integration Tests", () => {
  it("should return a list of active templates", async () => {
    const res = await request(app)
      .get("/api/templates")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.length).toBe(1); // Only active template should be returned
    expect(res.body.data[0].name).toBe("Active Test Template");
    expect(res.body.data[0].isActive).toBe(true);
  });

  it("should block templates fetch if unauthorized", async () => {
    const res = await request(app)
      .get("/api/templates");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  // --- Public gallery endpoint tests ---

  it("returns complete, matching metadata for legacy and configured templates on both lists", async () => {
    const legacyId = new mongoose.Types.ObjectId();
    const nullId = new mongoose.Types.ObjectId();
    const configuredId = new mongoose.Types.ObjectId();
    try {
      // Bypass schema defaults to reproduce records already stored in production.
      await Template.collection.insertMany([
        { _id: legacyId, name: "Job Application", category: "HR", theme: "classic-light", fields: [], isActive: true },
        { _id: nullId, name: "Legacy Custom", description: null, settings: null, category: "Test", theme: "classic-light", fields: [], isActive: true },
      ]);
      await Template.create({
        _id: configuredId, name: "Configured", description: "Custom description",
        category: "Test", theme: "classic-light", fields: [], isActive: true,
        settings: { layout: "two_column", successMessage: "All done!", responseLimitEnabled: true, responseLimit: 25, closeDate: "2027-01-01T00:00:00.000Z" },
      });

      const publicRes = await request(app).get("/api/templates/public");
      const privateRes = await request(app).get("/api/templates").set("Authorization", `Bearer ${authToken}`);
      expect(publicRes.status).toBe(200);
      expect(privateRes.status).toBe(200);
      expect(publicRes.body.data).toEqual(privateRes.body.data);
      for (const id of [legacyId, nullId]) {
        const item = publicRes.body.data.find((t: any) => t._id === id.toString());
        expect(item.description).toEqual(expect.any(String));
        expect(item.description.length).toBeGreaterThan(0);
        expect(item.settings).toEqual({
          layout: "single_column", successMessage: "Thank you! Your response has been submitted.",
          responseLimitEnabled: false, honeypotEnabled: false,
        });
        expect(item).not.toHaveProperty("createdAt");
        expect(item).not.toHaveProperty("__v");
      }
      const configured = publicRes.body.data.find((t: any) => t._id === configuredId.toString());
      expect(configured.description).toBe("Custom description");
      expect(configured.settings).toEqual({
        layout: "two_column", successMessage: "All done!", responseLimitEnabled: true,
        responseLimit: 25, closeDate: "2027-01-01T00:00:00.000Z", honeypotEnabled: false,
      });
    } finally {
      await Template.deleteMany({ _id: { $in: [legacyId, nullId, configuredId] } });
    }
  });

  it("should return active templates from /api/templates/public with NO auth", async () => {
    const res = await request(app)
      .get("/api/templates/public");
    // No Authorization header — must succeed

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data)).toBe(true);
    // Should contain only active templates (at least the one seeded)
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    res.body.data.forEach((t: any) => {
      expect(t.isActive).toBe(true);
    });
  });

  it("should exclude inactive templates from /api/templates/public", async () => {
    const res = await request(app)
      .get("/api/templates/public");

    expect(res.status).toBe(200);
    const ids = res.body.data.map((t: any) => t._id);
    expect(ids).not.toContain(inactiveTemplateId);
  });

  it("should create a form from an active template scoped to workspace", async () => {
    const res = await request(app)
      .post(`/api/templates/${activeTemplateId}/use`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.title).toBe("Active Test Template");
    expect(res.body.data.workspaceId).toBe(mockWorkspaceId);
    expect(res.body.data.fields.length).toBe(2);
    expect(res.body.data.fields[0].label).toBe("Full Name");
    expect(res.body.data.fields[1].label).toBe("Email Address");

    // Verify it exists in Mongo
    const dbForm = await Form.findById(res.body.data._id);
    expect(dbForm).not.toBeNull();
    expect(dbForm!.title).toBe("Active Test Template");
  });

  it("should reject use request on non-existent template ID with 404", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .post(`/api/templates/${fakeId}/use`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("should reject use request on inactive template ID with 404", async () => {
    const res = await request(app)
      .post(`/api/templates/${inactiveTemplateId}/use`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("should create a form from a template containing logicRules without throwing 500", async () => {
    const field1Id = new mongoose.Types.ObjectId().toString();
    const field2Id = new mongoose.Types.ObjectId().toString();

    const logicTemplate = await Template.create({
      name: "Pitch Template with Logic",
      category: "advanced",
      theme: "classic-light",
      isActive: true,
      fields: [
        {
          fieldId: field1Id,
          label: "Status of Project",
          type: "dropdown",
          required: true,
          options: ["Option A", "Option B"],
          logicRules: [
            {
              targetFieldId: field2Id,
              action: "show",
              operator: "equals",
              value: "Option A",
              condition: {
                fieldId: field1Id,
                operator: "equals",
                value: "Option A",
              },
            },
          ],
        },
        {
          fieldId: field2Id,
          label: "Followup Details",
          type: "long_text",
          required: false,
        },
      ],
    });

    const res = await request(app)
      .post(`/api/templates/${logicTemplate._id.toString()}/use`)
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.fields.length).toBe(2);

    const newField1 = res.body.data.fields[0];
    const newField2 = res.body.data.fields[1];

    expect(newField1.logicRules).toBeDefined();
    expect(newField1.logicRules.length).toBe(1);
    expect(newField1.logicRules[0].targetFieldId).toBe(newField2.fieldId);
    expect(newField1.logicRules[0].condition.fieldId).toBe(newField1.fieldId);
  });
});
