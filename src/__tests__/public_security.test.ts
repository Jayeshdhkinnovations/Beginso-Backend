import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import crypto from "crypto";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { generateToken } from "../utils/generateToken";
import { clearRateLimitStore } from "../middleware/rateLimiter";

let mongoServer: MongoMemoryServer;
let tokenA: string;
let adminA: any;
let wsA: any;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";
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
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe("Public Submit Security & Rate Limiting Integration Tests", () => {
  let slug: string;
  let formId: string;

  beforeEach(async () => {
    // Clear responses and rate limits
    await ResponseModel.deleteMany({});
    await clearRateLimitStore();

    // Reset env limits to avoid conflicting other tests
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;

    // Create a form
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Security Test Form",
        fields: [{ label: "Email", type: "email", required: true }],
        settings: {
          honeypotEnabled: true
        }
      });
    formId = createRes.body.form._id;

    // Publish the form
    const publishRes = await request(app)
      .post(`/api/forms/${formId}/publish`)
      .set("Authorization", `Bearer ${tokenA}`);
    slug = publishRes.body.slug;
  });

  it("should silently drop honeypot submissions returning 200 and saving nothing, with indistinguishable output", async () => {
    const answers = { Email: "spam@bot.com" };

    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify(answers))
      .field("_hp", "bot-value");

    // Must be 200
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Response submitted successfully");
    expect(res.body.submission).toBeDefined();
    expect(res.body.submission.formId.toString()).toBe(formId);
    expect(res.body.submission.answers.Email).toBe("spam@bot.com");

    // Assert nothing in DB
    const count = await ResponseModel.countDocuments({ formId });
    expect(count).toBe(0);
  });

  it("should enforce rate limit threshold and return 429 shape when exceeded", async () => {
    // Set low rate limit for this test.
    // ponytail: the limiter is a real fixed-window (see rateLimiter.ts's `hit`), keyed by
    // Math.floor(Date.now() / windowMs). With a 10s window, 3 sequential requests plus their DB
    // round-trips could straddle a window boundary when the full suite runs under parallel-worker
    // contention (all workers share one mongod — see globalSetup.ts), silently resetting the count
    // mid-test and turning the expected 429 into a 200. A 10-minute window makes that boundary
    // effectively unreachable within a single test's runtime, without touching the limiter itself.
    process.env.RATE_LIMIT_MAX = "2";
    process.env.RATE_LIMIT_WINDOW_MS = "600000"; // 10 minutes

    const answers = { Email: "test@example.com" };

    // Request 1 -> 200
    let res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify(answers));
    expect(res.status).toBe(200);

    // Request 2 -> 200
    res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify(answers));
    expect(res.status).toBe(200);

    // Request 3 -> 429 (Exceeded max = 2)
    res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify(answers));
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Too many requests. Please try again later.");
  });

  it("should store submission metadata including submittedAt and hashed IP", async () => {
    const answers = { Email: "test@example.com" };

    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .field("data", JSON.stringify(answers));
    expect(res.status).toBe(200);

    const submission = await ResponseModel.findOne({ formId });
    expect(submission).not.toBeNull();
    expect(submission?.submittedAt).toBeDefined();
    expect(submission?.submittedAt instanceof Date).toBe(true);
    expect(submission?.ipHash).toBeDefined();

    // Verify hashed IP is sha256 (64 hex characters)
    expect(submission?.ipHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
