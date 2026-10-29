// A chart can group by a Time question (by the hour of the day) and by a Date & time question (by day, week, month or year, like a date).
// A click on a bar of either gives the same number of responses in the Responses list as the bar says.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));
process.env.JWT_SECRET = "test-jwt-secret-key-for-chart-time-fields";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";
process.env.USER_RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { generateToken } from "../utils/generateToken";
import { hourLabel } from "../utils/chartQuery";
import { resetChartCache } from "../services/chartQuery.service";

let mongo: MongoMemoryServer;
let form: any;
let auth: Record<string, string>;

const TIME = { fieldId: "f-time", label: "Preferred Time" };
const WHEN = { fieldId: "f-when", label: "Booking" };

// 8 responses. Times: 09:15, 09:45, 14:05, 14:30, 14:59, 23:00, one with no time, one with text that is not a time.
// Bookings: two on 20 Oct 2026, one on 2 Nov 2026, one on 5 Jan 2027, the rest none.
const ANSWERS: Record<string, string | undefined>[] = [
  { time: "09:15", when: "2026-10-20T14:30" },
  { time: "09:45", when: "2026-10-20T09:00" },
  { time: "14:05", when: "2026-11-02T10:00" },
  { time: "14:30", when: "2027-01-05T08:00" },
  { time: "14:59" },
  { time: "23:00" },
  {},
  { time: "soon" },
];

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const owner: any = await User.create({ firebaseUid: "uid-tf-owner", fullName: "Owner", email: "tf-owner@test.com", role: "admin", status: "active" });
  const ws: any = await Workspace.create({ name: "TF WS", slug: "ws-tf", timezone: "Asia/Kolkata", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  auth = { Authorization: `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: "user" })}`, "x-workspace-slug": "ws-tf" };
  form = await Form.create({
    title: "Bookings", workspaceId: ws._id, createdBy: owner._id, status: "published", slug: "tf-1", publishedSlug: "tf-1",
    fields: [
      { ...TIME, pageId: "p1", type: "time", required: false },
      { ...WHEN, pageId: "p1", type: "datetime", required: false },
      { fieldId: "f-name", pageId: "p1", label: "Name", type: "short_text", required: false },
    ],
    pages: [{ id: "p1", order: 0, title: "P" }],
  } as any);
  await ResponseModel.create(
    ANSWERS.map((a, i) => ({
      formId: form._id,
      answers: { ...(a.time !== undefined ? { [TIME.label]: a.time } : {}), ...(a.when !== undefined ? { [WHEN.label]: a.when } : {}), Name: `r${i}` },
      status: "new",
      submittedAt: new Date(Date.UTC(2026, 9, 1 + i)),
    }))
  );
});
beforeEach(() => resetChartCache());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const measure = { type: "count" };
const query = (definition: any) => request(app).post(`/api/forms/${form._id}/charts/query`).set(auth).send({ definition });
const list = async (definition: any, focus?: any) => {
  const chart = encodeURIComponent(JSON.stringify({ definition, ...(focus ? { focus } : {}) }));
  const res = await request(app).get(`/api/responses?formId=${form._id}&limit=50&chart=${chart}`).set(auth);
  expect(res.status).toBe(200);
  return res.body.total as number;
};

describe("a Time question, grouped by the hour of the day", () => {
  const def = { kind: "simple", measure, groupBy: { field: { kind: "question", fieldId: TIME.fieldId } } };

  it("has one group for each hour somebody gave, earliest first, read as 9 AM / 2 PM / 11 PM", async () => {
    const res = await query(def);
    expect(res.status).toBe(200);
    expect(res.body.level).toMatchObject({ label: TIME.label, kind: "hour" });
    expect(res.body.level.bucket).toBeUndefined();
    expect(res.body.entries.map((e: any) => [e.label, e.n])).toEqual([["9 AM", 2], ["2 PM", 3], ["11 PM", 1]]);
    expect(res.body.entries.map((e: any) => e.focus.key)).toEqual(["9", "14", "23"]);
    // 8 responses: 6 gave a time; the one with none and the one with text that is not a time did not answer
    expect(res.body).toMatchObject({ total: 8, answered: 6, blank: 2 });
  });

  it("a click on a bar lists the responses behind it: the Responses list gives the same number as the bar", async () => {
    const res = await query(def);
    for (const e of res.body.entries) expect(await list(def, e.focus)).toBe(e.n);
    expect(await list(def)).toBe(8);
  });

  it("reads 12 AM, 12 PM and the hours either side of them the way people do", () => {
    expect([0, 1, 11, 12, 13, 23].map(hourLabel)).toEqual(["12 AM", "1 AM", "11 AM", "12 PM", "1 PM", "11 PM"]);
  });

  it("is not a date and not a filter: no date grouping, no filter on it", async () => {
    const withBucket = await query({ ...def, groupBy: { ...def.groupBy, bucket: "month" } });
    expect(withBucket.status).toBe(400);
    const filtered = await query({ ...def, groupBy: { field: { kind: "question", fieldId: "f-name" } }, filters: { op: "and", items: [{ field: { kind: "question", fieldId: TIME.fieldId }, op: "gt", value: 9 }] } });
    expect(filtered.status).toBe(400);
  });

  it("can be a level of a drill-down: the hour, then the booking month, narrowed by the hour that was clicked", async () => {
    const drill = {
      kind: "drilldown",
      measure,
      levels: [{ field: { kind: "question", fieldId: TIME.fieldId } }, { field: { kind: "question", fieldId: WHEN.fieldId }, bucket: "month" }],
    };
    const first = await request(app).post(`/api/forms/${form._id}/charts/query`).set(auth).send({ definition: drill });
    expect(first.status).toBe(200);
    expect(first.body.depth).toBe(0);
    const nine = first.body.entries.find((e: any) => e.label === "9 AM");
    const second = await request(app).post(`/api/forms/${form._id}/charts/query`).set(auth).send({ definition: drill, path: [{ level: 0, ...nine.focus }] });
    expect(second.status).toBe(200);
    expect(second.body.depth).toBe(1);
    expect(second.body.total).toBe(2); // the two 9 o'clock responses
    expect(second.body.entries.map((e: any) => [e.label, e.n])).toEqual([["Oct 2026", 2]]);
  });
});

describe("a Date & time question, grouped like a date", () => {
  const def = (bucket: string) => ({ kind: "simple", measure, groupBy: { field: { kind: "question", fieldId: WHEN.fieldId }, bucket } });

  it("by month: the date part is what counts, the time of day is not", async () => {
    const res = await query(def("month"));
    expect(res.status).toBe(200);
    expect(res.body.level).toMatchObject({ label: WHEN.label, kind: "date", bucket: "month" });
    expect(res.body.entries.map((e: any) => [e.label, e.n])).toEqual([["Oct 2026", 2], ["Nov 2026", 1], ["Jan 2027", 1]]);
    expect(res.body).toMatchObject({ total: 8, answered: 4, blank: 4 });
  });

  it("by day, and by year", async () => {
    const day = await query(def("day"));
    expect(day.body.entries.map((e: any) => [e.label, e.n])).toEqual([["20 Oct 2026", 2], ["2 Nov 2026", 1], ["5 Jan 2027", 1]]);
    const year = await query(def("year"));
    expect(year.body.entries.map((e: any) => [e.label, e.n])).toEqual([["2026", 3], ["2027", 1]]);
  });

  it("a click on a bar lists the same number of responses as the bar", async () => {
    const d = def("month");
    const res = await query(d);
    for (const e of res.body.entries) expect(await list(d, e.focus)).toBe(e.n);
  });
});
