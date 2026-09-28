// Sprint 7-11 backend deliverables that were missing: workspace input validation, membership scoping,
// real last-activity, per-member preferences, invitation purge, and permission/isolation properties.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import fc from "fast-check";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import Invitation from "../models/Invitation";
import SessionModel from "../models/Session";
import { Event } from "../models/Event";
import { generateToken } from "../utils/generateToken";
import { hasPermission, ROLE_PERMISSIONS } from "../middleware/permission.middleware";
import { superAdminService } from "../services/superadmin.service";
import { clearRateLimitStore } from "../middleware/rateLimiter";

process.env.JWT_SECRET = "test-jwt-secret-key-for-sprint11-completion";

let mongoServer: MongoMemoryServer;
const tok = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role });
const mkUser = (key: string) => User.create({ firebaseUid: `uid-s11-${key}`, fullName: key, email: `${key}@s11.test`, role: "admin", status: "active" });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User, Workspace, Membership, Form, Invitation, SessionModel, Event].map((m: any) => m.init()));
});

beforeEach(async () => {
  await clearRateLimitStore();
  await Promise.all([Form, Invitation, SessionModel, Membership, Workspace, User].map((m: any) => m.deleteMany({})));
  await Event.collection.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("workspace create/update validation (C1)", () => {
  it("refuses reserved and malformed slugs, long names and bad timezones; drops unknown keys", async () => {
    const u = await mkUser("creator");
    const post = (body: any) => request(app).post("/api/workspaces").set("Authorization", `Bearer ${tok(u)}`).send(body);
    for (const slug of ["current", "personal", "API", "a", "-bad-", "has space", "x".repeat(60)]) {
      expect((await post({ name: "Ok", slug })).status).toBe(400);
    }
    expect((await post({ name: "" })).status).toBe(400);
    expect((await post({ name: "x".repeat(81) })).status).toBe(400);
    expect((await post({ name: "Ok", timezone: "Not/AZone" })).status).toBe(400);
    expect((await post({ name: 42 as any })).status).toBe(400);

    const other = await mkUser("someone");
    const ok = await post({ name: "  Acme  ", slug: "Acme-Team", owner: String(other._id), status: "suspended" });
    expect(ok.status).toBe(201);
    expect(ok.body.workspace.slug).toBe("acme-team");
    expect(ok.body.workspace.name).toBe("Acme");
    expect(String(ok.body.workspace.owner)).toBe(String(u._id));
  });

  it("update validates the same way", async () => {
    const u = await mkUser("editor1");
    const ws: any = await Workspace.create({ name: "W", slug: "w-s11", timezone: "UTC", owner: u._id });
    await Membership.create({ userId: u._id, workspaceId: ws._id, role: "owner" });
    const put = (body: any) => request(app).put(`/api/workspaces/${ws._id}`).set("Authorization", `Bearer ${tok(u)}`).send(body);
    expect((await put({ name: "y".repeat(81) })).status).toBe(400);
    expect((await put({ timezone: "Nope/Zone" })).status).toBe(400);
    expect((await put({ name: "Renamed" })).status).toBe(200);
  });
});

describe("membershipId scoping (Sprint 7 merge blocker)", () => {
  it("a membership id from another workspace can be neither changed nor removed through this one", async () => {
    const [ownerA, ownerB, victim] = [await mkUser("oa"), await mkUser("ob"), await mkUser("victim")];
    const wsA: any = await Workspace.create({ name: "A", slug: "a-s11", timezone: "UTC", owner: ownerA._id });
    const wsB: any = await Workspace.create({ name: "B", slug: "b-s11", timezone: "UTC", owner: ownerB._id });
    await Membership.create([
      { userId: ownerA._id, workspaceId: wsA._id, role: "owner" },
      { userId: ownerB._id, workspaceId: wsB._id, role: "owner" },
    ]);
    const inB: any = await Membership.create({ userId: victim._id, workspaceId: wsB._id, role: "editor" });

    const as = (r: request.Test) => r.set("Authorization", `Bearer ${tok(ownerA)}`).set("x-workspace-id", String(wsA._id));
    expect((await as(request(app).patch(`/api/workspaces/${wsA._id}/members/${inB._id}`)).send({ role: "viewer" })).status).toBe(404);
    expect((await as(request(app).delete(`/api/workspaces/${wsA._id}/members/${inB._id}`))).status).toBe(404);
    expect((await Membership.findById(inB._id))?.role).toBe("editor");
    // and the owner of A cannot reach B's members at all
    expect((await as(request(app).get(`/api/workspaces/${wsB._id}/members`))).status).toBe(403);
  });
});

describe("last activity is real activity", () => {
  it("comes from the member's latest session, not from when their role row changed", async () => {
    const owner = await mkUser("own");
    const member = await mkUser("mem");
    const ws: any = await Workspace.create({ name: "A", slug: "act-s11", timezone: "UTC", owner: owner._id });
    await Membership.create([
      { userId: owner._id, workspaceId: ws._id, role: "owner" },
      { userId: member._id, workspaceId: ws._id, role: "editor" },
    ]);
    const seen = new Date("2026-09-20T10:00:00.000Z");
    await SessionModel.create({ userId: member._id, deviceLabel: "x", userAgent: "x", ipHash: "x", lastActiveAt: new Date("2026-09-01T00:00:00.000Z") });
    await SessionModel.create({ userId: member._id, deviceLabel: "y", userAgent: "y", ipHash: "y", lastActiveAt: seen });
    const res = await request(app).get(`/api/workspaces/${ws._id}/members`).set("Authorization", `Bearer ${tok(owner)}`).set("x-workspace-id", String(ws._id));
    const row = res.body.members.find((m: any) => m.email === "mem@s11.test");
    expect(new Date(row.lastActiveAt).toISOString()).toBe(seen.toISOString());
  });
});

describe("per-member preferences (P1, P2)", () => {
  it("a member sets their own notification preference and timezone; bad values are refused; others are untouched", async () => {
    const owner = await mkUser("po");
    const member = await mkUser("pm");
    const ws: any = await Workspace.create({ name: "P", slug: "pref-s11", timezone: "UTC", owner: owner._id });
    await Membership.create([
      { userId: owner._id, workspaceId: ws._id, role: "owner" },
      { userId: member._id, workspaceId: ws._id, role: "viewer" },
    ]);
    const patch = (u: any, body: any) => request(app).patch(`/api/workspaces/${ws._id}/preferences`).set("Authorization", `Bearer ${tok(u)}`).set("x-workspace-id", String(ws._id)).send(body);

    const ok = await patch(member, { notificationPreference: "mine", timezoneOverride: "Asia/Kolkata" });
    expect(ok.status).toBe(200);
    expect(ok.body.preferences).toEqual({ notificationPreference: "mine", timezoneOverride: "Asia/Kolkata" });
    expect((await patch(member, { notificationPreference: "assigned" })).status).toBe(400);
    expect((await patch(member, { timezoneOverride: "Nope/Zone" })).status).toBe(400);
    expect((await patch(member, { timezoneOverride: null })).status).toBe(200);

    const ownerRow: any = await Membership.findOne({ userId: owner._id, workspaceId: ws._id });
    expect(ownerRow.timezoneOverride ?? null).toBeNull();
  });
});

describe("invitations and admin provisioning", () => {
  it("an invitation gets a purge date 30 days after it expires, backed by a TTL index", async () => {
    const owner = await mkUser("io");
    const ws: any = await Workspace.create({ name: "I", slug: "inv-s11", timezone: "UTC", owner: owner._id });
    await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
    const res = await request(app).post(`/api/workspaces/${ws._id}/invitations`).set("Authorization", `Bearer ${tok(owner)}`).set("x-workspace-id", String(ws._id)).send({ email: "new@s11.test", role: "viewer" });
    expect(res.status).toBe(201);
    const inv: any = await Invitation.findOne({ email: "new@s11.test" });
    expect(inv.purgeAt.getTime() - inv.expiresAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    const ttl = Invitation.schema.indexes().find(([spec]: any[]) => JSON.stringify(spec) === JSON.stringify({ purgeAt: 1 }));
    expect(ttl?.[1]).toMatchObject({ expireAfterSeconds: 0 });
  });

  it("a super-admin-created admin gets an owner Membership for their workspace", async () => {
    const { auth } = require("../config/firebase");
    const spy = jest.spyOn(auth, "createUser").mockResolvedValue({ uid: "uid-s11-newadmin" } as never);
    const boss = await mkUser("boss");
    await superAdminService.createAdmin({ id: String(boss._id), email: boss.email, fullName: "boss" }, { name: "New Admin", email: "na@s11.test", workspaceName: "Fresh" });
    spy.mockRestore();
    const admin: any = await User.findOne({ email: "na@s11.test" });
    const row: any = await Membership.findOne({ userId: admin._id, workspaceId: admin.workspaceId });
    expect(row?.role).toBe("owner");
  });
});

// ---- Property-based tests (Sprint 11 BE 0.2) --------------------------------------------------

const ROLES = ["owner", "admin", "member", "editor", "viewer", "reviewer"] as const;
const PERMISSIONS = Array.from(new Set(Object.values(ROLE_PERMISSIONS).flat())).filter((p) => p !== "*").concat(["forms:delete", "workspace:delete", "team:manage", "nonexistent:thing"]);

describe("permission matrix properties", () => {
  it("editor is exactly member and reviewer is exactly viewer, for every permission", () => {
    fc.assert(fc.property(fc.constantFrom(...PERMISSIONS), (p) => hasPermission("editor", p) === hasPermission("member", p) && hasPermission("reviewer", p) === hasPermission("viewer", p)));
  });

  it("access only ever shrinks down the ladder owner > admin > member > viewer", () => {
    const ladder = ["owner", "admin", "member", "viewer"] as const;
    fc.assert(
      fc.property(fc.constantFrom(...PERMISSIONS), fc.integer({ min: 0, max: 2 }), (p, i) => {
        // if a lower role has the permission, every role above it has it too
        return !hasPermission(ladder[i + 1], p) || hasPermission(ladder[i], p);
      })
    );
  });

  it("nothing but the owner can delete forms or the workspace, and unknown permissions are refused to everyone but the owner", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ROLES), (role) => {
        const ownerOnly = ["forms:delete", "workspace:delete"].every((p) => hasPermission(role, p) === (role === "owner"));
        const unknown = hasPermission(role, "nonexistent:thing") === (role === "owner");
        return ownerOnly && unknown;
      })
    );
  });
});

describe("tenant isolation property", () => {
  it("for any assignment of users to workspaces, nobody reads or writes a form in a workspace they do not belong to", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom(0, 1, 2), fc.constantFrom(...ROLES)), { minLength: 1, maxLength: 4 }),
        fc.constantFrom(0, 1, 2),
        async (assignments, formWs) => {
          await Promise.all([Form, Membership, Workspace, User].map((m: any) => m.deleteMany({})));
          const owners = [await mkUser("p0"), await mkUser("p1"), await mkUser("p2")];
          const wss: any[] = [];
          for (let i = 0; i < 3; i++) {
            const w: any = await Workspace.create({ name: `W${i}`, slug: `prop-${i}-s11`, timezone: "UTC", owner: owners[i]._id });
            await Membership.create({ userId: owners[i]._id, workspaceId: w._id, role: "owner" });
            wss.push(w);
          }
          const form: any = await Form.create({ title: "F", workspaceId: wss[formWs]._id, createdBy: owners[formWs]._id, fields: [{ fieldId: "f", label: "Q", type: "short_text", required: false }] });

          for (const [i, [wsIdx, role]] of assignments.entries()) {
            const u = await mkUser(`x${i}`);
            if (wsIdx !== formWs) await Membership.create({ userId: u._id, workspaceId: wss[wsIdx]._id, role });
            // a user with NO link to the form's workspace, in any header combination
            for (const header of [String(wss[wsIdx]._id), "personal", String(wss[formWs]._id)]) {
              const base = (r: request.Test) => r.set("Authorization", `Bearer ${tok(u)}`).set("x-workspace-id", header);
              const read = await base(request(app).get(`/api/forms/${form._id}`));
              const write = await base(request(app).patch(`/api/forms/${form._id}`)).send({ title: "hijacked" });
              if (![403, 404].includes(read.status) || ![403, 404].includes(write.status)) return false;
            }
          }
          return String((await Form.findById(form._id))?.title) === "F";
        }
      ),
      { numRuns: 8 }
    );
  });
});
