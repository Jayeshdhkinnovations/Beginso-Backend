// GET /api/responses?q= finds a response by any part of an answer. The search used to read every response's answers a second time on
// every request (to catch rows stored before searchText existed); that check is now remembered for a few minutes.
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
import { ResponseService } from "../services/response.service";
import { ResponseRepository } from "../repositories/response.repository";
import { clearRateLimitStore } from "../middleware/rateLimiter";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-response-search";

let mongo: MongoMemoryServer;
let form: any;
let auth: Record<string, string>;

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const owner: any = await User.create({ firebaseUid: "uid-se-owner", fullName: "Owner", email: "se-owner@test.com", role: "admin", status: "active" });
  const ws: any = await Workspace.create({ name: "SE WS", slug: "se-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  auth = { Authorization: `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: "user" })}`, "x-workspace-slug": "se-ws" };
  form = await Form.create({
    title: "Searchable", workspaceId: ws._id, createdBy: owner._id, status: "published", slug: "se-1", publishedSlug: "se-1",
    fields: [{ fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: false }], pages: [{ id: "p1", order: 0, title: "P" }],
  } as any);
});

beforeEach(async () => {
  clearRateLimitStore();
  await ResponseModel.deleteMany({});
  await ResponseModel.create([
    { formId: form._id, answers: { Name: "Harsh Vanzara" }, status: "new", searchText: "harsh vanzara harsh@gmail.com" },
    { formId: form._id, answers: { Name: "Gerardo Gabaldon" }, status: "new", searchText: "gerardo gabaldon gerardo@gmail.com" },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const find = async (q: string) => {
  const res = await request(app).get(`/api/responses?formId=${form._id}&limit=50&q=${encodeURIComponent(q)}`).set(auth);
  expect(res.status).toBe(200);
  return (res.body.data as any[]).map((r) => r.answers.Name).sort();
};

describe("GET /api/responses?q=", () => {
  it("finds a response by any part of an answer, ignoring case", async () => {
    expect(await find("HARSH")).toEqual(["Harsh Vanzara"]);
    expect(await find("gabal")).toEqual(["Gerardo Gabaldon"]);
    expect(await find("@gmail")).toEqual(["Gerardo Gabaldon", "Harsh Vanzara"]);
    expect(await find("nobody")).toEqual([]);
  });

  it("still finds a response stored before searchText existed", async () => {
    await ResponseModel.collection.insertOne({ formId: form._id, answers: { Name: "Old Timer" }, status: "new", deletedAt: null, tagIds: [] });
    (ResponseService as any).allHaveSearchTextUntil = 0; // forget the remembered check
    expect(await find("timer")).toEqual(["Old Timer"]);
  });

  it("does not read every response a second time when all of them have a searchText", async () => {
    (ResponseService as any).allHaveSearchTextUntil = 0;
    const spy = jest.spyOn(ResponseRepository.prototype, "findWithPagination");
    await find("harsh"); // the first search finds out that nothing lacks a searchText
    spy.mockClear();
    await find("gerardo");
    expect(spy).toHaveBeenCalledTimes(1); // the page itself; the scan for rows without searchText would be a second call
    spy.mockRestore();
  });
});
