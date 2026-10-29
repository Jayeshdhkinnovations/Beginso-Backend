// GET /api/responses?formId=&sortBy=score&order=asc|desc sorts every page by the average score: the mean of every reviewer's every criterion,
// the same number the list shows in `scoreAverage`. A response nobody has scored goes last whichever way it goes, newest first among those.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import ScoreEntryModel from "../models/ScoreEntry";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { clearRateLimitStore } from "../middleware/rateLimiter";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-responses-sort-by-score";

let mongo: MongoMemoryServer;
let form: any;
let auth: Record<string, string>;

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const owner: any = await User.create({ firebaseUid: "uid-ss-owner", fullName: "Owner", email: "ss-owner@test.com", role: "admin", status: "active" });
  const ws: any = await Workspace.create({ name: "SS WS", slug: "ss-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  auth = { Authorization: `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: "user" })}`, "x-workspace-slug": "ss-ws" };
  form = await Form.create({
    title: "Scored", workspaceId: ws._id, createdBy: owner._id, status: "published", slug: "ss-1", publishedSlug: "ss-1",
    fields: [{ fieldId: "f-name", pageId: "p1", label: "Name", type: "short_text", required: false }],
    pages: [{ id: "p1", order: 0, title: "P" }],
  } as any);

  // Submitted a, b, c, d, e (oldest first). Averages: a = 8, b = (4 + 6) / 2 = 5, c = none, d = 9 (two reviewers: 10 and 8), e = none.
  const created: any[] = await ResponseModel.create(
    ["a", "b", "c", "d", "e"].map((n, i) => ({ formId: form._id, answers: { Name: n }, status: "new", submittedAt: new Date(Date.UTC(2026, 0, i + 1)) }))
  );
  const [a, b, , d] = created;
  const reviewer1 = new mongoose.Types.ObjectId();
  const reviewer2 = new mongoose.Types.ObjectId();
  const crit1 = new mongoose.Types.ObjectId();
  const crit2 = new mongoose.Types.ObjectId();
  const entry = (response: any, reviewer: mongoose.Types.ObjectId, criterion: mongoose.Types.ObjectId, value: number) => ({
    responseId: response._id, reviewerMembershipId: reviewer, criterionId: criterion, value,
  });
  await ScoreEntryModel.create([
    entry(a, reviewer1, crit1, 8),
    entry(b, reviewer1, crit1, 4),
    entry(b, reviewer1, crit2, 6),
    entry(d, reviewer1, crit1, 10),
    entry(d, reviewer2, crit1, 8),
  ]);
});
beforeEach(() => clearRateLimitStore());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const list = async (qs: string) => {
  const res = await request(app).get(`/api/responses?formId=${form._id}${qs}`).set(auth);
  expect(res.status).toBe(200);
  return res.body;
};
const names = async (qs: string) => ((await list(qs)).data as any[]).map((r) => r.answers.Name);

describe("sorting the Responses list by the average score", () => {
  it("highest first with order=desc, lowest first with order=asc, and the unscored last either way (newest first among them)", async () => {
    expect(await names("&limit=50&sortBy=score&order=desc")).toEqual(["d", "a", "b", "e", "c"]);
    expect(await names("&limit=50&sortBy=score&order=asc")).toEqual(["b", "a", "d", "e", "c"]);
  });

  it("sorts across pages, not just the rows of one: page 2 continues where page 1 stopped", async () => {
    expect(await names("&limit=2&page=1&sortBy=score&order=desc")).toEqual(["d", "a"]);
    expect(await names("&limit=2&page=2&sortBy=score&order=desc")).toEqual(["b", "e"]);
    expect(await names("&limit=2&page=3&sortBy=score&order=desc")).toEqual(["c"]);
  });

  it("orders by the same number the list shows (scoreAverage), with the reviewer count beside it, and keeps the total", async () => {
    const body = await list("&limit=50&sortBy=score&order=desc");
    expect(body.total).toBe(5);
    const rows = body.data as any[];
    expect(rows.map((r) => r.scoreAverage)).toEqual([9, 8, 5, null, null]);
    expect(rows.map((r) => r.scoreCount)).toEqual([2, 1, 1, 0, 0]);
    // the helper fields used to sort never leak into the response
    expect(rows[0].__avg).toBeUndefined();
    expect(rows[0].__scores).toBeUndefined();
  });

  it("is not the default: without sortBy the list is still newest first", async () => {
    expect(await names("&limit=50")).toEqual(["e", "d", "c", "b", "a"]);
  });
});
