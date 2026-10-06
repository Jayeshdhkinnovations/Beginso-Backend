import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import ReportModel from "../models/Report";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;
let userToken: string;
let otherUserToken: string;
let workspace: any;
let otherWorkspace: any;
let testForm: any;
let otherForm: any;

process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  // Create primary workspace owner & workspace
  const user = await User.create({
    firebaseUid: "analytics-uid-1",
    fullName: "Analytics Admin",
    email: "analytics1@test.com",
    role: "admin",
    status: "active",
  });
  workspace = await Workspace.create({
    name: "Analytics Workspace",
    owner: user._id,
  });
  user.workspaceId = workspace._id as any;
  await user.save();
  userToken = generateToken({ id: user._id.toString(), email: user.email, role: user.role });

  // Create second workspace owner & workspace (for 403 cross-workspace tests)
  const otherUser = await User.create({
    firebaseUid: "analytics-uid-2",
    fullName: "Other Admin",
    email: "analytics2@test.com",
    role: "admin",
    status: "active",
  });
  otherWorkspace = await Workspace.create({
    name: "Other Workspace",
    owner: otherUser._id,
  });
  otherUser.workspaceId = otherWorkspace._id as any;
  await otherUser.save();
  otherUserToken = generateToken({ id: otherUser._id.toString(), email: otherUser.email, role: otherUser.role });

  // Create form in primary workspace with checkbox and dropdown
  testForm = await Form.create({
    title: "Customer Feedback",
    workspaceId: workspace._id,
    status: "published",
    publishedSlug: "feedback-slug",
    fields: [
      {
        fieldId: "field_rating",
        label: "Overall Satisfaction",
        type: "dropdown",
        required: false,
        options: ["Great", "Average", "Poor"],
      },
      {
        fieldId: "field_features",
        label: "Features Used",
        type: "checkbox",
        required: false,
        options: ["Analytics", "Forms", "Reports"],
      },
      {
        fieldId: "field_comments",
        label: "Additional Comments",
        type: "short_text",
        required: false,
      },
    ],
  });

  // Create form in second workspace
  otherForm = await Form.create({
    title: "Other Form",
    workspaceId: otherWorkspace._id,
    status: "published",
    publishedSlug: "other-slug",
    fields: [],
  });

  // Seed responses for testForm
  await ResponseModel.create([
    {
      formId: testForm._id,
      status: "completed",
      submittedAt: new Date("2026-08-05T10:00:00Z"),
      answers: { field_rating: "Great", field_features: ["Analytics", "Reports"], field_comments: "Awesome product!" },
    },
    {
      formId: testForm._id,
      status: "completed",
      submittedAt: new Date("2026-08-06T12:00:00Z"),
      answers: { field_rating: "Great", field_features: ["Analytics"], field_comments: "Very good" },
    },
    {
      formId: testForm._id,
      status: "in_progress",
      submittedAt: new Date("2026-08-07T14:00:00Z"),
      answers: { field_rating: "Average", field_features: ["Forms"] },
    },
    {
      formId: testForm._id,
      status: "new",
      submittedAt: new Date("2026-08-08T16:00:00Z"),
      answers: {},
    },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe("GET /api/analytics/overview", () => {
  it("should return 400 if formId query param is missing or invalid", async () => {
    const res1 = await request(app)
      .get("/api/analytics/overview")
      .set("Authorization", `Bearer ${userToken}`);
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .get("/api/analytics/overview?formId=invalid-id")
      .set("Authorization", `Bearer ${userToken}`);
    expect(res2.status).toBe(400);
  });

  it("should return 404 if form does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .get(`/api/analytics/overview?formId=${fakeId}`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(404);
  });

  it("should return 403 if form belongs to another workspace", async () => {
    const res = await request(app)
      .get(`/api/analytics/overview?formId=${otherForm._id}`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("should return KPI totals, real completionRate, and statusDistribution using MongoDB $group", async () => {
    const res = await request(app)
      .get(`/api/analytics/overview?formId=${testForm._id}&from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z&timezone=UTC`)
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data.formId).toBe(testForm._id.toString());
    expect(data.total).toBe(4);
    expect(data.completed).toBe(2);
    expect(data.in_progress).toBe(1);
    expect(data.new).toBe(1);
    // Sprint 14 (OQ-3): the stage-based figure is now `reviewedRate`; `completionRate` is submissions / views (null: no views).
    expect(data.reviewedRate).toBe(50); // 2 completed / 4 total = 50%
    expect(data.completionRate).toBeNull();
    expect(Array.isArray(data.statusDistribution)).toBe(true);
  });
});

describe("GET /api/analytics/questions", () => {
  it("should return question summary with multi-value checkbox counting and zero-count options included", async () => {
    const res = await request(app)
      .get(`/api/analytics/questions?formId=${testForm._id}`)
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data.totalResponses).toBe(4);

    const checkboxQ = data.questions.find((q: any) => q.fieldId === "field_features");
    expect(checkboxQ).toBeDefined();
    expect(checkboxQ.totalAnswered).toBe(3);

    // Verify option multi-value counting
    const options = checkboxQ.summary.options;
    const analyticsOpt = options.find((o: any) => o.label === "Analytics");
    const reportsOpt = options.find((o: any) => o.label === "Reports");
    const formsOpt = options.find((o: any) => o.label === "Forms");

    expect(analyticsOpt.count).toBe(2);
    expect(reportsOpt.count).toBe(1);
    expect(formsOpt.count).toBe(1);

    // Verify zero-count options included for dropdown
    const ratingQ = data.questions.find((q: any) => q.fieldId === "field_rating");
    const poorOpt = ratingQ.summary.options.find((o: any) => o.label === "Poor");
    expect(poorOpt).toBeDefined();
    expect(poorOpt.count).toBe(0);
    expect(poorOpt.percentage).toBe(0);
  });

  it("should resolve answer counts when responses store answers keyed by human label instead of fieldId", async () => {
    const labelForm: any = await Form.create({
      title: "Label Keyed Form",
      workspaceId: workspace._id,
      status: "published",
      fields: [
        {
          fieldId: "q_prod_123",
          label: "Product Choice",
          type: "dropdown",
          options: ["Product A", "Product B"],
        },
      ] as any,
    });

    await ResponseModel.create([
      {
        formId: labelForm._id,
        status: "completed",
        submittedAt: new Date(),
        answers: { "Product Choice": "Product A" },
      },
      {
        formId: labelForm._id,
        status: "completed",
        submittedAt: new Date(),
        answers: { "Product Choice": "Product B" },
      },
    ]);

    const res = await request(app)
      .get(`/api/analytics/questions?formId=${labelForm._id}`)
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const q = res.body.data.questions[0];
    expect(q.totalAnswered).toBe(2);
    const prodA = q.summary.options.find((o: any) => o.label === "Product A");
    const prodB = q.summary.options.find((o: any) => o.label === "Product B");
    expect(prodA.count).toBe(1);
    expect(prodB.count).toBe(1);
  });
});

describe("GET /api/analytics/trends - Day vs Week Bucket Selection", () => {
  it("should aggregate by day when bucket=day", async () => {
    const res = await request(app)
      .get(`/api/analytics/trends?formId=${testForm._id}&bucket=day`)
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.points)).toBe(true);
    expect(res.body.dateRange.bucket).toBe("day");
  });

  it("should aggregate by week when bucket=week", async () => {
    const res = await request(app)
      .get(`/api/analytics/trends?formId=${testForm._id}&bucket=week`)
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.points)).toBe(true);
    expect(res.body.dateRange.bucket).toBe("week");
  });
});

describe("Reports API (/api/reports)", () => {
  let createdReportId: string;

  it("POST /api/reports - should create a queued CSV report job and return 202 immediately", async () => {
    const res = await request(app)
      .post("/api/reports")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        format: "csv",
        formId: testForm._id.toString(),
      });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.report.status).toBe("queued");
    expect(res.body.report.format).toBe("csv");
    createdReportId = res.body.report.id;
  });

  it("GET /api/reports - should list workspace report jobs paginated", async () => {
    const res = await request(app)
      .get("/api/reports?page=1&limit=10")
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/reports/:id - should get report detail", async () => {
    const res = await request(app)
      .get(`/api/reports/${createdReportId}`)
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.report.id).toBe(createdReportId);
  });

  it("GET /api/reports/:id/file - should reject access to report from another workspace (403)", async () => {
    const res = await request(app)
      .get(`/api/reports/${createdReportId}/file`)
      .set("Authorization", `Bearer ${otherUserToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});
