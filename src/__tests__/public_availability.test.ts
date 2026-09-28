import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { generateToken } from "../utils/generateToken";
import { closeExpiredForms } from "../services/form.service";

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

describe("Public Form closeDate & responseLimit Integration Tests", () => {
  it("should return 404 on fetch and submit if closeDate has passed, and the sweep closes it", async () => {
    // 1. Create a form with closeDate in the past
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Expired Form",
        fields: [{ label: "Email", type: "email", required: true }],
        settings: {
          closeDate: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        }
      });
    expect(createRes.status).toBe(201);
    const formId = createRes.body.form._id;

    // 2. Publish it
    const publishRes = await request(app)
      .post(`/api/forms/${formId}/publish`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(publishRes.status).toBe(200);
    const slug = publishRes.body.slug;

    // Check that status starts as published
    let formInDb = await Form.findById(formId);
    expect(formInDb?.status).toBe("published");

    // 3. Try to fetch public schema -> should return 404
    const fetchRes = await request(app).get(`/api/public/${slug}`);
    expect(fetchRes.status).toBe(404);

    // A public GET never writes: the stored status is still "published" ...
    formInDb = await Form.findById(formId);
    expect(formInDb?.status).toBe("published");
    // ... until the sweep (or a submit attempt) brings it in line.
    expect(await closeExpiredForms()).toBe(1);
    formInDb = await Form.findById(formId);
    expect(formInDb?.status).toBe("closed");

    // 4. Try to submit -> should return 404
    const submitRes = await request(app)
      .post(`/api/public/${slug}/submit`)
      .send({
        answers: [{ fieldLabel: "Email", value: "test@example.com" }]
      });
    expect(submitRes.status).toBe(404);
  });

  it("should return 200 on fetch and 201 on submit if closeDate is in the future", async () => {
    // 1. Create a form with closeDate in the future
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Active Future Form",
        fields: [{ label: "Email", type: "email", required: true }],
        settings: {
          closeDate: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
        }
      });
    const formId = createRes.body.form._id;

    // 2. Publish it
    const publishRes = await request(app)
      .post(`/api/forms/${formId}/publish`)
      .set("Authorization", `Bearer ${tokenA}`);
    const slug = publishRes.body.slug;

    // 3. Try to fetch public schema -> should succeed (200)
    const fetchRes = await request(app).get(`/api/public/${slug}`);
    expect(fetchRes.status).toBe(200);

    // 4. Try to submit -> should succeed (201)
    const submitRes = await request(app)
      .post(`/api/public/${slug}/submit`)
      .send({
        answers: [{ fieldLabel: "Email", value: "test@example.com" }]
      });
    expect(submitRes.status).toBe(200);
  });

  it("should return 404 on fetch and submit if responseLimit has been reached, and lazily flip status to closed", async () => {
    // 1. Create a form with responseLimit = 1 (responseLimitEnabled = true)
    const createRes = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        title: "Capped Form",
        fields: [{ label: "Email", type: "email", required: true }],
        settings: {
          responseLimitEnabled: true,
          responseLimit: 1,
        }
      });
    const formId = createRes.body.form._id;

    // 2. Publish it
    const publishRes = await request(app)
      .post(`/api/forms/${formId}/publish`)
      .set("Authorization", `Bearer ${tokenA}`);
    const slug = publishRes.body.slug;

    // 3. Create a dummy response to reach the limit
    await ResponseModel.create({
      formId: formId,
      answers: { Email: "first@example.com" }
    });

    // Check that status starts as published
    let formInDb = await Form.findById(formId);
    expect(formInDb?.status).toBe("published");

    // 4. Try to fetch public schema -> should return 404
    const fetchRes = await request(app).get(`/api/public/${slug}`);
    expect(fetchRes.status).toBe(404);

    // A public GET never writes, so the form is still marked published ...
    formInDb = await Form.findById(formId);
    expect(formInDb?.status).toBe("published");

    // 5. ... and a submit attempt is refused and flips it to closed
    const submitRes = await request(app)
      .post(`/api/public/${slug}/submit`)
      .send({
        answers: [{ fieldLabel: "Email", value: "second@example.com" }]
      });
    expect(submitRes.status).toBe(404);
    formInDb = await Form.findById(formId);
    expect(formInDb?.status).toBe("closed");
  });
});
