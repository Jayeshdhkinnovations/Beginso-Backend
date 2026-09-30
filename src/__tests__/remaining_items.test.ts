// Remaining Medium/Low audit items: revoked-token login, hashed invitation links, report queue,
// submissions paging, HTTPS geolocation, indexes.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { getAuth } from "firebase-admin/auth";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Report from "../models/Report";
import Upload from "../models/Upload";
import Notification from "../models/Notification";
import { generateToken } from "../utils/generateToken";
import * as reportService from "../services/report.service";
import { kickReportQueue, recoverReportQueue } from "../services/reportQueue";
import { resolveIpLocation } from "../services/geolocation.service";
import { clearRateLimitStore } from "../middleware/rateLimiter";

process.env.JWT_SECRET = "test-jwt-secret-key-for-remaining-items";

let mongoServer: MongoMemoryServer;
let owner: any;
let ws: any;
const tok = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Bug fix (CI flake): a flat `sleep(300)` assumed the queue's async processing always lands
// inside that window — true on a fast local machine, not guaranteed on a CPU-shared CI runner.
// Polls instead of guessing a fixed duration, so this is correct regardless of how fast/slow the
// event loop happens to be, with a generous 5s ceiling rather than tightening a magic number.
async function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User, Workspace, Membership, Form, ResponseModel, Report].map((m: any) => m.init()));
});

beforeEach(async () => {
  await clearRateLimitStore();
  await Promise.all([Form, ResponseModel, Report, Membership, Workspace, User].map((m: any) => m.deleteMany({})));
  owner = await User.create({ firebaseUid: "uid-rem", fullName: "own", email: "own@rem.test", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "Rem", slug: "rem-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("session login checks Firebase revocation", () => {
  it("asks Firebase to check revocation, and a revoked token is a clear 401", async () => {
    const auth: any = getAuth();
    const original = auth.verifyIdToken;
    const calls: any[][] = [];
    auth.verifyIdToken = async (...args: any[]) => {
      calls.push(args);
      throw Object.assign(new Error("The Firebase ID token has been revoked."), { code: "auth/id-token-revoked" });
    };
    const res = await request(app).post("/api/auth/session").send({ token: "revoked-token" });
    auth.verifyIdToken = original;
    expect(calls[0][1]).toBe(true);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_REVOKED");
    expect(JSON.stringify(res.body)).not.toContain("Firebase ID token has been revoked");
  });
});

describe("report queue", () => {
  const mkReport = (n: number) =>
    Report.create({ workspaceId: ws._id, format: "csv", filters: {}, status: "queued", expiresAt: new Date(Date.now() + 1e6), createdAt: new Date(Date.now() + n) } as any);

  it("runs at most REPORT_CONCURRENCY jobs at once, oldest first, and continues as slots free up", async () => {
    process.env.REPORT_CONCURRENCY = "1";
    const started: string[] = [];
    const release: Array<() => void> = [];
    const spy = jest.spyOn(reportService, "generateReportAsync").mockImplementation(
      (id: string) => new Promise<void>((resolve) => {
        started.push(id);
        release.push(resolve);
      })
    );
    const [a, b, c] = [await mkReport(1), await mkReport(2), await mkReport(3)];
    kickReportQueue();
    await waitUntil(() => started.length === 1);
    expect(started).toEqual([String(a._id)]);
    release[0]();
    await waitUntil(() => started.length === 2);
    expect(started).toEqual([String(a._id), String(b._id)]);
    release[1]();
    await waitUntil(() => started.length === 3);
    expect(started).toEqual([String(a._id), String(b._id), String(c._id)]);
    release[2]();
    spy.mockRestore();
    delete process.env.REPORT_CONCURRENCY;
  });

  it("puts jobs left processing by a restart back in the queue", async () => {
    const stale: any = await Report.create({ workspaceId: ws._id, format: "csv", filters: {}, status: "processing", expiresAt: new Date(Date.now() + 1e6) });
    await Report.collection.updateOne({ _id: stale._id }, { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    const spy = jest.spyOn(reportService, "generateReportAsync").mockResolvedValue(undefined);
    await recoverReportQueue();
    await sleep(200);
    // it was re-queued and picked up again: generation started for exactly this job
    expect(spy.mock.calls.map((c) => c[0])).toEqual([String(stale._id)]);
    spy.mockRestore();
  });
});

describe("submissions are paged", () => {
  it("returns a page with total and totalPages", async () => {
    const form: any = await Form.create({ title: "P", workspaceId: ws._id, createdBy: owner._id, fields: [{ fieldId: "f", label: "Q", type: "short_text", required: false }] });
    await ResponseModel.create(Array.from({ length: 5 }, (_, i) => ({ formId: form._id, answers: { Q: `a${i}` } })));
    const res = await request(app)
      .get(`/api/forms/${form._id}/submissions`)
      .query({ page: 2, limit: 2 })
      .set("Authorization", `Bearer ${tok(owner)}`)
      .set("x-workspace-id", ws._id.toString());
    expect(res.status).toBe(200);
    expect(res.body.submissions).toHaveLength(2);
    expect(res.body).toMatchObject({ total: 5, page: 2, limit: 2, totalPages: 3 });
  });
});

describe("geolocation uses HTTPS", () => {
  it("calls an https URL and reads the provider's fields", async () => {
    const urls: string[] = [];
    const realFetch = global.fetch;
    global.fetch = (async (url: any) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ success: true, city: "Mumbai", region: "Maharashtra", country: "India", latitude: 19.07, longitude: 72.87 }) } as any;
    }) as any;
    const loc = await resolveIpLocation("103.42.193.24");
    global.fetch = realFetch;
    expect(urls[0].startsWith("https://")).toBe(true);
    expect(loc).toEqual({ city: "Mumbai", region: "Maharashtra", country: "India", latitude: 19.07, longitude: 72.87 });
  });
});

describe("indexes exist for the hot queries", () => {
  const has = (model: any, key: Record<string, number>) => model.schema.indexes().some(([spec]: any[]) => JSON.stringify(spec) === JSON.stringify(key));
  it("Upload.path, Form lists, Notification list, submissions and the report queue", () => {
    expect(has(Upload, { path: 1 })).toBe(true);
    expect(has(Form, { workspaceId: 1, createdAt: -1 })).toBe(true);
    expect(has(Form, { createdBy: 1, workspaceId: 1, createdAt: -1 })).toBe(true);
    expect(has(Notification, { userId: 1, createdAt: -1 })).toBe(true);
    expect(has(ResponseModel, { formId: 1, createdAt: -1 })).toBe(true);
    expect(has(Report, { status: 1, createdAt: 1 })).toBe(true);
  });
});
