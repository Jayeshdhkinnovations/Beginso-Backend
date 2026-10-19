// QA D8-006: the Inbox table sorted only the 50 rows it had loaded, so "oldest first" was wrong whenever a form had more than one page.
// GET /api/responses now takes order=asc|desc (by submission time) and applies it across every page.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { clearRateLimitStore } from "../middleware/rateLimiter";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-responses-order";

let mongo: MongoMemoryServer;
let form: any;
let auth: Record<string, string>;

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const owner: any = await User.create({ firebaseUid: "uid-ord-owner", fullName: "Owner", email: "ord-owner@test.com", role: "admin", status: "active" });
  const ws: any = await Workspace.create({ name: "ORD WS", slug: "ord-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  auth = { Authorization: `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: "user" })}`, "x-workspace-slug": "ord-ws" };
  form = await Form.create({
    title: "Ordered", workspaceId: ws._id, createdBy: owner._id, status: "published", slug: "ord-1", publishedSlug: "ord-1",
    fields: [{ fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: false }], pages: [{ id: "p1", order: 0, title: "P" }],
  });
  // Twelve responses, one per day: r01 is the oldest, r12 the newest.
  await ResponseModel.create(
    Array.from({ length: 12 }, (_, i) => ({
      formId: form._id,
      answers: { Name: `r${String(i + 1).padStart(2, "0")}` },
      status: "new",
      submittedAt: new Date(Date.UTC(2026, 0, i + 1)),
    }))
  );
});
beforeEach(() => clearRateLimitStore());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const names = async (qs: string) => {
  const res = await request(app).get(`/api/responses?formId=${form._id}&limit=5${qs}`).set(auth);
  expect(res.status).toBe(200);
  return (res.body.data as any[]).map((r) => r.answers.Name);
};

describe("GET /api/responses order (across pages)", () => {
  it("is newest first by default", async () => {
    expect(await names("&page=1")).toEqual(["r12", "r11", "r10", "r09", "r08"]);
  });

  it("order=asc is oldest first on every page, with no row repeated or dropped between pages", async () => {
    const all = [...(await names("&order=asc&page=1")), ...(await names("&order=asc&page=2")), ...(await names("&order=asc&page=3"))];
    expect(all).toEqual(["r01", "r02", "r03", "r04", "r05", "r06", "r07", "r08", "r09", "r10", "r11", "r12"]);
  });

  it("order=desc and an unknown value both mean newest first", async () => {
    expect(await names("&order=desc&page=2")).toEqual(["r07", "r06", "r05", "r04", "r03"]);
    expect(await names("&order=sideways&page=1")).toEqual(["r12", "r11", "r10", "r09", "r08"]);
  });
});
