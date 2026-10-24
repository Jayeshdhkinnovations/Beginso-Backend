// GET /api/responses?formId=&sortBy=q:<fieldId>|email&order=asc|desc sorts every page by a column other than the submission time:
// the answer to one question, or the respondent's email. Letters ignore case, numbers sort as numbers, blanks come last.
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

process.env.JWT_SECRET = "test-jwt-secret-key-for-responses-sort-by";

let mongo: MongoMemoryServer;
let form: any;
let auth: Record<string, string>;

// label with a dot in it: stored under a key that a dotted path would misread as nesting
const DOT_LABEL = "Specified keyword. (separate comma)";

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const owner: any = await User.create({ firebaseUid: "uid-sb-owner", fullName: "Owner", email: "sb-owner@test.com", role: "admin", status: "active" });
  const ws: any = await Workspace.create({ name: "SB WS", slug: "sb-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  auth = { Authorization: `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: "user" })}`, "x-workspace-slug": "sb-ws" };
  form = await Form.create({
    title: "Sortable", workspaceId: ws._id, createdBy: owner._id, status: "published", slug: "sb-1", publishedSlug: "sb-1",
    fields: [
      { fieldId: "f-name", pageId: "p1", label: "Name", type: "short_text", required: false },
      { fieldId: "f-budget", pageId: "p1", label: "Budget", type: "short_text", required: false },
      { fieldId: "f-dot", pageId: "p1", label: DOT_LABEL, type: "short_text", required: false },
    ],
    pages: [{ id: "p1", order: 0, title: "P" }],
  } as any);
  // Newest first by submission would be: e, d, c, b, a
  const rows = [
    { n: "a", budget: "100", dot: "zeta", email: "bob@x.com" },
    { n: "B", budget: "9", dot: "Alpha", email: "Amy@x.com" },
    { n: "c", budget: "20", dot: "", email: null },
    { n: "d", budget: undefined, dot: "beta", email: "carl@x.com" },
    { n: "e", budget: "3", dot: undefined, email: "" },
  ];
  await ResponseModel.create(
    rows.map((r, i) => ({
      formId: form._id,
      answers: { Name: r.n, ...(r.budget !== undefined ? { Budget: r.budget } : {}), ...(r.dot !== undefined ? { [DOT_LABEL]: r.dot } : {}) },
      respondentEmail: r.email,
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
  const res = await request(app).get(`/api/responses?formId=${form._id}&limit=50${qs}`).set(auth);
  expect(res.status).toBe(200);
  return (res.body.data as any[]).map((r) => r.answers.Name);
};

describe("GET /api/responses?sortBy=", () => {
  it("by a question: letters ignore case, ascending and descending", async () => {
    expect(await names("&sortBy=q:f-name&order=asc")).toEqual(["a", "B", "c", "d", "e"]);
    expect(await names("&sortBy=q:f-name&order=desc")).toEqual(["e", "d", "c", "B", "a"]);
  });

  it("numbers in a text answer sort as numbers (9 before 20 before 100), and a blank answer is last either way", async () => {
    expect(await names("&sortBy=q:f-budget&order=asc")).toEqual(["e", "B", "c", "a", "d"]); // 3, 9, 20, 100, then the blank
    expect(await names("&sortBy=q:f-budget&order=desc")).toEqual(["a", "c", "B", "e", "d"]); // 100, 20, 9, 3, then the blank
  });

  it("a question whose label contains a dot sorts like any other (blank and missing answers last)", async () => {
    expect(await names("&sortBy=q:f-dot&order=asc")).toEqual(["B", "d", "a", "e", "c"]); // Alpha, beta, zeta, then the two blanks, newest first
  });

  it("by email, with blank addresses last", async () => {
    expect(await names("&sortBy=email&order=asc")).toEqual(["B", "a", "d", "e", "c"]); // Amy, bob, carl, then the two blanks, newest first
    expect(await names("&sortBy=email&order=desc")).toEqual(["d", "a", "B", "e", "c"]); // carl, bob, Amy, then the two blanks, newest first
  });

  it("is one order across pages: no row repeated or dropped", async () => {
    const page = async (n: number) => {
      const res = await request(app).get(`/api/responses?formId=${form._id}&limit=2&page=${n}&sortBy=q:f-name&order=asc`).set(auth);
      return (res.body.data as any[]).map((r) => r.answers.Name);
    };
    expect([...(await page(1)), ...(await page(2)), ...(await page(3))]).toEqual(["a", "B", "c", "d", "e"]);
  });

  it("an unknown question, a deleted one, or a sort without a form falls back to newest first", async () => {
    expect(await names("&sortBy=q:nope&order=desc")).toEqual(["e", "d", "c", "B", "a"]);
    const res = await request(app).get(`/api/responses?sortBy=q:f-name&order=asc&limit=50`).set(auth);
    expect(res.status).toBe(200);
  });

  it("still answers with the usual fields (stage, tags, answers without the sort helpers)", async () => {
    const res = await request(app).get(`/api/responses?formId=${form._id}&limit=2&sortBy=q:f-name&order=asc`).set(auth);
    const row = res.body.data[0];
    expect(row).toMatchObject({ _id: expect.any(String), formId: String(form._id), status: "new" });
    expect(JSON.stringify(row)).not.toContain("__sortValue");
    expect(JSON.stringify(row)).not.toContain("__blank");
    expect(res.body.total).toBe(5);
  });
});
