// Saved Home layouts (/api/dashboards/home): one personal layout per user, one shared layout per workspace.
// The scope header is mandatory, a save must name the version it was based on, writing a workspace layout needs
// dashboard:manage, and a widget list is validated strictly.
process.env.JWT_SECRET = "test-jwt-secret-key-for-dashboard-layout";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Dashboard from "../models/Dashboard";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;
let owner: any, admin: any, editor: any, viewer: any;
let ws: any;
let t: Record<string, string>;

const token = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role || "user" });
const hdr = (tok: string, scope?: string) => ({ Authorization: `Bearer ${tok}`, ...(scope ? { "x-workspace-slug": scope } : {}) });
const get = (tok: string, scope?: string) => request(app).get("/api/dashboards/home").set(hdr(tok, scope));
const put = (tok: string, body: any, scope?: string) => request(app).put("/api/dashboards/home").set(hdr(tok, scope)).send(body);
const del = (tok: string, scope?: string) => request(app).delete("/api/dashboards/home").set(hdr(tok, scope));

const kpi = (id: string, extra: Record<string, any> = {}) => ({ id, w: 3, config: { type: "kpi", variant: 1, metric: "totalForms", ...extra } });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User.init(), Workspace.init(), Membership.init(), Dashboard.init()]);

  const mk = (n: string) => User.create({ firebaseUid: `uid-dash-${n}`, fullName: `${n} D`, email: `${n}@dash.test`, status: "active" });
  [owner, admin, editor, viewer] = await Promise.all(["owner", "admin", "editor", "viewer"].map(mk));
  t = { owner: token(owner), admin: token(admin), editor: token(editor), viewer: token(viewer) };
  ws = await Workspace.create({ name: "Dash Workspace", owner: owner._id });
  await Membership.create([
    { userId: owner._id, workspaceId: ws._id, role: "owner" },
    { userId: admin._id, workspaceId: ws._id, role: "admin" },
    { userId: editor._id, workspaceId: ws._id, role: "editor" },
    { userId: viewer._id, workspaceId: ws._id, role: "viewer" },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Dashboard.deleteMany({});
});

describe("scope and sign-in", () => {
  it("answers 401 without a session", async () => {
    expect((await request(app).get("/api/dashboards/home").set("x-workspace-slug", ws.slug)).status).toBe(401);
  });

  it("requires the x-workspace-slug header (no silent fallback to a default workspace)", async () => {
    const res = await get(t.owner);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SCOPE_REQUIRED");
  });

  it("answers 403 for a workspace the caller does not belong to", async () => {
    const stranger = await User.create({ firebaseUid: "uid-dash-stranger", fullName: "S", email: "stranger@dash.test", status: "active" });
    expect((await get(token(stranger), ws.slug)).status).toBe(403);
  });
});

describe("saving a workspace layout", () => {
  it("returns null until something is saved", async () => {
    const res = await get(t.viewer, ws.slug);
    expect(res.status).toBe(200);
    expect(res.body.dashboard).toBeNull();
  });

  it("creates the layout at version 1 and every later save adds one", async () => {
    const first = await put(t.owner, { widgets: [kpi("a")] }, ws.slug);
    expect(first.status).toBe(200);
    expect(first.body.dashboard.version).toBe(1);

    const second = await put(t.admin, { widgets: [kpi("a"), kpi("b")], version: 1 }, ws.slug);
    expect(second.status).toBe(200);
    expect(second.body.dashboard.version).toBe(2);
    expect(second.body.dashboard.widgets).toHaveLength(2);

    // everyone in the workspace sees the same document
    const read = await get(t.viewer, ws.slug);
    expect(read.body.dashboard.version).toBe(2);
    expect(await Dashboard.countDocuments({ workspaceId: ws._id })).toBe(1);
  });

  it("answers 409 with the current layout when the version is stale", async () => {
    await put(t.owner, { widgets: [kpi("a")] }, ws.slug);
    await put(t.owner, { widgets: [kpi("a"), kpi("b")], version: 1 }, ws.slug);
    const stale = await put(t.admin, { widgets: [kpi("z")], version: 1 }, ws.slug);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    expect(stale.body.dashboard.version).toBe(2);
    expect(stale.body.dashboard.widgets).toHaveLength(2);
  });

  it("refuses a save that names no version once a layout exists (it would overwrite someone else's)", async () => {
    await put(t.owner, { widgets: [kpi("a")] }, ws.slug);
    const blind = await put(t.owner, { widgets: [kpi("overwrite")] }, ws.slug);
    expect(blind.status).toBe(409);
    expect((await get(t.owner, ws.slug)).body.dashboard.widgets[0].id).toBe("a");
  });
});

describe("who may change a layout", () => {
  it("lets every member read but only owner and admin write a workspace layout", async () => {
    expect((await get(t.editor, ws.slug)).status).toBe(200);
    expect((await put(t.editor, { widgets: [kpi("a")] }, ws.slug)).status).toBe(403);
    expect((await put(t.viewer, { widgets: [kpi("a")] }, ws.slug)).status).toBe(403);
    expect((await del(t.editor, ws.slug)).status).toBe(403);
    expect((await put(t.admin, { widgets: [kpi("a")] }, ws.slug)).status).toBe(200);
    expect((await put(t.owner, { widgets: [kpi("a")], version: 1 }, ws.slug)).status).toBe(200);
  });

  it("keeps a personal layout private to its user and always writable by them", async () => {
    const mine = await put(t.editor, { widgets: [kpi("mine")] }, "personal");
    expect(mine.status).toBe(200);
    expect((await get(t.editor, "personal")).body.dashboard.widgets[0].id).toBe("mine");
    expect((await get(t.owner, "personal")).body.dashboard).toBeNull();
    expect(await Dashboard.countDocuments({ workspaceId: null })).toBe(1);
  });
});

describe("validation of the widget list", () => {
  const bad = async (widgets: any) => (await put(t.owner, { widgets }, ws.slug)).status;

  it("accepts every widget kind, the full width and a KPI tone", async () => {
    const res = await put(
      t.owner,
      {
        widgets: [
          kpi("k", { tone: "success" }),
          { id: "c", w: 6, config: { type: "chart", chart: "donut", metric: "formsByStatus" } },
          { id: "m", w: 12, config: { type: "map", metric: "responseLocations" } },
        ],
      },
      ws.slug
    );
    expect(res.status).toBe(200);
  });

  it("rejects unknown keys, bad widths, duplicate ids, bad metrics and too many widgets", async () => {
    expect(await bad([{ ...kpi("a"), extra: true }])).toBe(400);
    expect(await bad([{ id: "a", w: 5, config: { type: "kpi", variant: 1, metric: "x" } }])).toBe(400);
    expect(await bad([kpi("same"), kpi("same")])).toBe(400);
    expect(await bad([kpi("a", { metric: "has space" })])).toBe(400);
    expect(await bad([kpi("a", { tone: "neon" })])).toBe(400);
    expect(await bad([{ id: "c", w: 4, config: { type: "chart", chart: "radar", metric: "x" } }])).toBe(400);
    expect(await bad(Array.from({ length: 41 }, (_, i) => kpi(`w${i}`)))).toBe(400);
  });

  it("returns the field-level reasons in errors[]", async () => {
    const res = await put(t.owner, { widgets: [kpi("same"), kpi("same")] }, ws.slug);
    expect(res.body.errors?.[0]?.message).toMatch(/unique/i);
  });
});

describe("resetting", () => {
  it("deletes the layout so the next read is null, and deleting nothing is fine", async () => {
    await put(t.owner, { widgets: [kpi("a")] }, ws.slug);
    expect((await del(t.owner, ws.slug)).status).toBe(200);
    expect((await get(t.owner, ws.slug)).body.dashboard).toBeNull();
    expect((await del(t.owner, ws.slug)).status).toBe(200);
  });
});
