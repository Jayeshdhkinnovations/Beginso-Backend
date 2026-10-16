// QA A16-010 (the audit listing returned a logged 500 for a malformed filter) and A7-013 (Home stats read zero for an
// account with personal forms but no workspace).
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { Event } from "../models/Event";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-qa-data-bugs";

let mongoServer: MongoMemoryServer;
let owner: any;
let loner: any; // belongs to no workspace
let ws: any;

const tok = (u: any) => ({ Authorization: `Bearer ${generateToken({ id: u._id.toString(), email: u.email, role: u.role })}` });
const audit = (query = "") => request(app).get(`/api/workspaces/${ws._id}/audit${query}`).set({ ...tok(owner), "x-workspace-id": ws._id.toString() });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  owner = await User.create({ firebaseUid: "uid-qd-owner", fullName: "QD Owner", email: "qd-owner@test.com", role: "admin", status: "active" });
  loner = await User.create({ firebaseUid: "uid-qd-loner", fullName: "QD Loner", email: "qd-loner@test.com", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "QD WS", slug: "qd-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  await Event.create([
    { workspaceId: ws._id, actorId: owner._id, actorEmail: "qd-owner@test.com", actorName: "QD Owner", action: "form.publish", targetId: new mongoose.Types.ObjectId(), targetType: "form", targetLabel: "A", createdAt: new Date("2026-03-01T00:00:00Z") },
    { workspaceId: ws._id, actorId: owner._id, actorEmail: "qd-owner@test.com", actorName: "QD Owner", action: "form.close", targetId: new mongoose.Types.ObjectId(), targetType: "form", targetLabel: "B", createdAt: new Date("2026-04-01T00:00:00Z") },
  ] as any);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("audit log filters are validated before they reach the database (A16-010)", () => {
  it.each([
    ["a malformed actorId", "?actorId=not-an-id"],
    ["a 12-character actorId (not a real id)", "?actorId=123456789012"],
    ["a malformed from date", "?from=garbage"],
    ["a malformed to date", "?to=garbage"],
    ["a repeated filter", "?action=a&action=b"],
  ])("%s is a 400, not a logged 500", async (_name, query) => {
    const res = await audit(query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_FILTER");
  });

  it("valid filters still work: by actor, action, date range and email", async () => {
    expect((await audit()).body.events).toHaveLength(2);
    expect((await audit(`?actorId=${owner._id}`)).body.events).toHaveLength(2);
    expect((await audit("?action=form.close")).body.events.map((e: any) => e.action)).toEqual(["form.close"]);
    expect((await audit("?from=2026-03-15&to=2026-12-31")).body.events.map((e: any) => e.action)).toEqual(["form.close"]);
    expect((await audit("?actorEmail=QD-OWNER")).body.events).toHaveLength(2);
    expect((await audit("?from=2026-12-01&to=2026-01-01")).body.events).toEqual([]); // an inverted range is just empty
  });

  it("bracket syntax cannot smuggle a query operator in: it is not parsed into an object, so the filter is simply absent", async () => {
    expect((await audit("?actorId[$ne]=x")).body.events).toHaveLength(2);
    expect((await audit("?action[$regex]=.*")).body.events).toHaveLength(2);
  });

  it("empty filter values are ignored, as the filter bar sends them", async () => {
    expect((await audit("?actorId=&action=&from=&to=")).body.events).toHaveLength(2);
  });
});

describe("Home stats for an account with personal forms and no workspace (A7-013)", () => {
  it("count the personal forms and their responses, with no header at all", async () => {
    const a: any = await Form.create({ title: "Mine A", createdBy: loner._id, workspaceId: null, status: "published", fields: [] });
    await Form.create({ title: "Mine B", createdBy: loner._id, workspaceId: null, status: "draft", fields: [] });
    await ResponseModel.create([{ formId: a._id, answers: {} }, { formId: a._id, answers: {} }, { formId: a._id, answers: {} }]);

    for (const headers of [tok(loner), { ...tok(loner), "x-workspace-slug": "personal" }]) {
      const res = await request(app).get("/api/dashboard/analytics").set(headers);
      expect(res.status).toBe(200);
      expect(res.body.analytics.totalForms).toBe(2);
      expect(res.body.analytics.publishedForms).toBe(1);
      expect(res.body.analytics.totalResponses).toBe(3);
    }
  });

  it("another user's personal forms never leak in", async () => {
    const res = await request(app).get("/api/dashboard/analytics").set(tok(owner));
    expect(res.body.analytics.totalForms).toBe(0);
    expect(res.body.analytics.totalResponses).toBe(0);
  });
});
