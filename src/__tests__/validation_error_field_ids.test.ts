import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import { generateToken } from "../utils/generateToken";

// A 422 named a field only by its label. A form with two questions both called "Comment" could not say WHICH one failed, and the
// public form put the message on the first. Every error now also carries the field's id.
let mongoServer: MongoMemoryServer;
let token: string;
let ws: any;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const owner: any = await User.create({ firebaseUid: "uid-fid", fullName: "Owner FID", email: "owner-fid@test.com", role: "admin" });
  ws = await Workspace.create({ name: "FID Workspace", slug: "fid-workspace", owner: owner._id });
  owner.workspaceId = ws._id;
  await owner.save();
  token = generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role });
}, 900000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe("422 validation errors identify the field by id", () => {
  it("names the second of two same-labelled questions, not just the label", async () => {
    const created = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${token}`)
      .set("x-workspace-slug", ws.slug)
      .send({
        title: "Two comments",
        fields: [
          { label: "Comment", type: "short_text", required: true },
          { label: "Comment", type: "short_text", required: true },
        ],
        settings: { honeypotEnabled: true },
      });
    expect(created.status).toBe(201);
    const formId = created.body.form._id;
    const published = await request(app).post(`/api/forms/${formId}/publish`).set("Authorization", `Bearer ${token}`).set("x-workspace-slug", ws.slug);
    const stored: any = await Form.findById(formId);
    const [first, second] = stored.fields;
    expect(first.fieldId).not.toBe(second.fieldId);

    // Only the first question is answered; the second is required and missing.
    const res = await request(app)
      .post(`/api/public/${published.body.slug}/submit`)
      .field("data", JSON.stringify({ answers: [{ fieldId: first.fieldId, value: "hello" }] }));
    expect(res.status).toBe(422);
    const errors: { field: string; fieldId?: string; message: string }[] = res.body.errors;
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("Comment"); // unchanged, for older clients
    expect(errors[0].fieldId).toBe(second.fieldId);
  });
});
