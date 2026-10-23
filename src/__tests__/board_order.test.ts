// The Board lets a card be dropped between two others, and keeps it there. GET /api/responses?sort=board lists a column in that order
// (cards never placed by hand on top, newest first), and POST /api/responses/:id/board-position places one card.
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
import { rankBetween } from "../services/boardOrder.service";

process.env.JWT_SECRET = "test-jwt-secret-key-for-board-order";

let mongo: MongoMemoryServer;
let form: any;
let otherForm: any;
let auth: Record<string, string>;
let outsider: Record<string, string>;
let ids: Record<string, string>;

const seed = async () => {
  await ResponseModel.deleteMany({});
  // r1 is the oldest, r5 the newest: with nothing placed by hand the column reads r5 r4 r3 r2 r1.
  const rows = await ResponseModel.create(
    Array.from({ length: 5 }, (_, i) => ({
      formId: form._id,
      answers: { Name: `r${i + 1}` },
      status: "new",
      submittedAt: new Date(Date.UTC(2026, 0, i + 1)),
    }))
  );
  ids = Object.fromEntries(rows.map((r: any, i: number) => [`r${i + 1}`, r._id.toString()]));
};

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const owner: any = await User.create({ firebaseUid: "uid-bo-owner", fullName: "Owner", email: "bo-owner@test.com", role: "admin", status: "active" });
  const ws: any = await Workspace.create({ name: "BO WS", slug: "bo-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  auth = { Authorization: `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: "user" })}`, "x-workspace-slug": "bo-ws" };

  const stranger: any = await User.create({ firebaseUid: "uid-bo-out", fullName: "Out", email: "bo-out@test.com", role: "admin", status: "active" });
  const ws2: any = await Workspace.create({ name: "BO WS2", slug: "bo-ws2", timezone: "UTC", owner: stranger._id });
  await Membership.create({ userId: stranger._id, workspaceId: ws2._id, role: "owner" });
  outsider = { Authorization: `Bearer ${generateToken({ id: stranger._id.toString(), email: stranger.email, role: "user" })}`, "x-workspace-slug": "bo-ws2" };

  const mk = (slug: string) => ({
    title: slug, workspaceId: ws._id, createdBy: owner._id, status: "published", slug, publishedSlug: slug,
    fields: [{ fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: false }], pages: [{ id: "p1", order: 0, title: "P" }],
  });
  form = await Form.create(mk("bo-1") as any);
  otherForm = await Form.create(mk("bo-2") as any);
});
beforeEach(async () => {
  clearRateLimitStore();
  await seed();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const column = async (extra = "") => {
  const res = await request(app).get(`/api/responses?formId=${form._id}&status=new&sort=board&limit=50${extra}`).set(auth);
  expect(res.status).toBe(200);
  return (res.body.data as any[]).map((r) => r.answers.Name);
};
const place = (id: string, body: object, headers = auth) => request(app).post(`/api/responses/${id}/board-position`).set(headers).send(body);

describe("rankBetween", () => {
  it("sits between two ranks, and a thousand past the end it is placed at", () => {
    expect(rankBetween(1000, 2000)).toBe(1500);
    expect(rankBetween(1000, null)).toBe(2000);
    expect(rankBetween(null, 1000)).toBe(0);
    expect(rankBetween(null, null)).toBe(0);
  });
});

describe("the Board's order", () => {
  it("lists cards nobody has placed newest first", async () => {
    expect(await column()).toEqual(["r5", "r4", "r3", "r2", "r1"]);
  });

  it("drops a card between two others and keeps it there", async () => {
    // r1 (the oldest, last) goes between r5 and r4.
    const res = await place(ids.r1, { afterId: ids.r5, beforeId: ids.r4 });
    expect(res.status).toBe(200);
    expect(await column()).toEqual(["r5", "r1", "r4", "r3", "r2"]);
  });

  it("drops a card at the end, and at the top", async () => {
    await place(ids.r5, { afterId: ids.r1 });
    expect(await column()).toEqual(["r4", "r3", "r2", "r1", "r5"]);
    await place(ids.r5, {});
    expect(await column()).toEqual(["r5", "r4", "r3", "r2", "r1"]);
  });

  it("works from the card below alone, and moves a card up and down several times", async () => {
    await place(ids.r2, { beforeId: ids.r5 });
    expect(await column()).toEqual(["r2", "r5", "r4", "r3", "r1"]);
    await place(ids.r2, { afterId: ids.r4 });
    expect(await column()).toEqual(["r5", "r4", "r2", "r3", "r1"]);
    await place(ids.r3, { afterId: ids.r5 });
    await place(ids.r1, { afterId: ids.r5 });
    expect(await column()).toEqual(["r5", "r1", "r3", "r4", "r2"]);
  });

  it("keeps the order across pages", async () => {
    await place(ids.r1, { afterId: ids.r5 });
    const page = async (n: number) => ((await request(app).get(`/api/responses?formId=${form._id}&status=new&sort=board&limit=2&page=${n}`).set(auth)).body.data as any[]).map((r) => r.answers.Name);
    expect([...(await page(1)), ...(await page(2)), ...(await page(3))]).toEqual(["r5", "r1", "r4", "r3", "r2"]);
  });

  it("puts a new submission at the top of a column that has been arranged", async () => {
    await place(ids.r1, { afterId: ids.r5 });
    await ResponseModel.create({ formId: form._id, answers: { Name: "r6" }, status: "new", submittedAt: new Date(Date.UTC(2026, 0, 6)) });
    expect((await column())[0]).toBe("r6");
  });

  it("forgets the place when the card changes column", async () => {
    await place(ids.r1, { afterId: ids.r5 });
    await request(app).patch(`/api/responses/${ids.r1}`).set(auth).send({ status: "completed" });
    const moved: any = await ResponseModel.findById(ids.r1).lean();
    expect(moved.boardRank).toBeUndefined();
    expect(await column()).toEqual(["r5", "r4", "r3", "r2"]);
  });

  it("never changes the default list order", async () => {
    await place(ids.r1, { afterId: ids.r5 });
    const res = await request(app).get(`/api/responses?formId=${form._id}&status=new&limit=50`).set(auth);
    expect((res.body.data as any[]).map((r) => r.answers.Name)).toEqual(["r5", "r4", "r3", "r2", "r1"]);
  });
});

describe("placing a card: what is refused", () => {
  it("a neighbour from another column or form is a 422", async () => {
    await ResponseModel.updateOne({ _id: ids.r3 }, { $set: { status: "completed" } });
    expect((await place(ids.r1, { afterId: ids.r3 })).status).toBe(422);
    const foreign: any = await ResponseModel.create({ formId: otherForm._id, answers: { Name: "x" }, status: "new" });
    expect((await place(ids.r1, { afterId: foreign._id.toString() })).status).toBe(422);
    expect((await place(ids.r1, { afterId: "not-an-id" })).status).toBe(422);
  });

  it("another workspace cannot place a card; an unknown card is a 404", async () => {
    expect((await place(ids.r1, { afterId: ids.r5 }, outsider)).status).toBe(403);
    expect((await place(new mongoose.Types.ObjectId().toString(), {})).status).toBe(404);
  });
});
