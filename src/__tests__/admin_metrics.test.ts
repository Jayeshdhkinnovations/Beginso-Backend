// The super admin figures that used to read "Not available": email verification, active users per day and completion rate.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import User from "../models/User";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import UserActivity, { recordActivity } from "../models/UserActivity";
import { getEngagementMetrics, getGrowthMetrics, getUsageMetrics } from "../services/adminMetrics.service";

const mockGetUsers = jest.fn();
jest.mock("firebase-admin/auth", () => {
  const actual = jest.requireActual("firebase-admin/auth");
  return { ...actual, getAuth: () => ({ getUsers: (ids: unknown[]) => mockGetUsers(ids) }) };
});

let mongoServer: MongoMemoryServer;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const key = (d: Date) => d.toISOString().slice(0, 10);

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User, Form, ResponseModel, UserActivity].map((m: any) => m.init()));
});

beforeEach(async () => {
  mockGetUsers.mockReset();
  mockGetUsers.mockResolvedValue({ users: [] });
  await Promise.all([User, Form, ResponseModel, UserActivity].map((m: any) => m.collection.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const user = (n: number, extra: Record<string, unknown> = {}) =>
  User.create({ firebaseUid: `uid-${n}`, fullName: `U${n}`, email: `u${n}@metrics.test`, role: "admin", status: "active", ...extra });

describe("verified and unverified accounts", () => {
  it("counts what Firebase says, in batches of 100, and the accounts it does not know", async () => {
    await User.collection.insertMany(Array.from({ length: 103 }, (_, i) => ({ firebaseUid: `uid-${i}`, email: `b${i}@metrics.test`, role: "admin", createdAt: new Date() })));
    mockGetUsers.mockImplementation(async (ids: { uid: string }[]) => ({
      users: ids.filter((x) => x.uid !== "uid-102").map((x) => ({ uid: x.uid, emailVerified: Number(x.uid.slice(4)) % 2 === 0 })),
    }));
    const { data } = await getGrowthMetrics({ refresh: true });
    expect(mockGetUsers.mock.calls.map((c) => c[0].length)).toEqual([100, 3]);
    expect(data.verifiedVsUnverified).toEqual({ available: true, verified: 51, unverified: 51, unknown: 1 });
  });

  it("says why when Firebase does not answer, without failing the page", async () => {
    await user(1);
    mockGetUsers.mockRejectedValue(new Error("network"));
    const { data } = await getGrowthMetrics({ refresh: true });
    expect(data.verifiedVsUnverified).toMatchObject({ available: false });
    expect(data.registrations.length).toBeGreaterThan(0);
  });
});

describe("active users per day", () => {
  it("is not available until something is recorded", async () => {
    const { data } = await getEngagementMetrics({ refresh: true });
    expect(data.activeUsers.series).toMatchObject({ available: false });
  });

  it("keeps one row per user per day and counts distinct registered users each day", async () => {
    const a = await user(1);
    const b = await user(2);
    await recordActivity(a._id, daysAgo(2));
    await recordActivity(a._id, daysAgo(2));
    await recordActivity(b._id, daysAgo(2));
    await recordActivity(a._id);
    await recordActivity(new mongoose.Types.ObjectId()); // no such account any more: not counted
    expect(await UserActivity.countDocuments()).toBe(4);

    const { data } = await getEngagementMetrics({ refresh: true });
    const series = data.activeUsers.series as { available: true; since: string; values: number[] };
    expect(series.since).toBe(key(daysAgo(2)));
    const on = (n: number) => series.values[data.days.indexOf(key(daysAgo(n)))];
    expect([on(2), on(1), on(0)]).toEqual([2, 0, 1]);
  });
});

describe("completion rate", () => {
  const form = (title: string, viewsCount: number) => Form.create({ title, createdBy: new mongoose.Types.ObjectId(), viewsCount, fields: [] });
  const responses = (formId: unknown, n: number, extra: Record<string, unknown> = {}) =>
    ResponseModel.collection.insertMany(Array.from({ length: n }, () => ({ formId, deletedAt: null, submittedAt: new Date(), ...extra })));

  it("is not available while no form has a recorded view", async () => {
    await form("Unviewed", 0);
    const { data } = await getUsageMetrics({ refresh: true });
    expect(data.completionRate).toMatchObject({ available: false });
  });

  it("divides responses by views, leaving out test responses and forms whose views are incomplete", async () => {
    const counted = await form("Counted", 10);
    await responses(counted._id, 4);
    await responses(counted._id, 3, { isTest: true });
    const older = await form("Older than view counting", 1);
    await responses(older._id, 20);
    const { data } = await getUsageMetrics({ refresh: true });
    expect(data.completionRate).toEqual({ available: true, value: 40, views: 10, submissions: 4, forms: 1 });
  });
});
