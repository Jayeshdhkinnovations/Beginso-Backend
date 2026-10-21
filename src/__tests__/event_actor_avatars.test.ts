// Activity, audit and per-form event feeds carry each actor's profile picture, so the app can show a real avatar next to a person's
// name for every role (the members list that could supply it is admin-only, and Activity is open to every member).
process.env.JWT_SECRET = "test-jwt-secret-key-for-event-actor-avatars";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import { Event } from "../models/Event";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;
let owner: any, member: any, viewer: any, noAvatar: any;
let ws: any, form: any;
const token = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role || "user" });
const as = (u: any) => ({ Authorization: `Bearer ${token(u)}` });

const seed = (actor: any | null, action: string, extra: Record<string, any> = {}) =>
  Event.create({
    workspaceId: ws._id,
    ...(actor ? { actorId: actor._id } : {}),
    actorEmail: actor?.email ?? "respondent@example.com",
    actorName: actor?.fullName ?? "Respondent",
    action,
    targetId: form._id.toString(),
    targetType: "form",
    targetLabel: form.title,
    createdAt: new Date(),
    ...extra,
  });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Workspace.init(), Membership.init(), Form.init(), Event.init()]);

  const mk = (n: string, avatarUrl?: string) => User.create({ firebaseUid: `uid-av-${n}`, fullName: `${n} Person`, email: `${n}@av.test`, status: "active", ...(avatarUrl ? { avatarUrl } : {}) });
  owner = await mk("owner", "https://cdn.example.com/avatars/owner.png");
  member = await mk("member", "/avatars/04.svg");
  viewer = await mk("viewer");
  noAvatar = await mk("plain");
  ws = await Workspace.create({ name: "Avatar WS", slug: "avatar-ws", owner: owner._id });
  await Membership.create([
    { userId: owner._id, workspaceId: ws._id, role: "owner" },
    { userId: member._id, workspaceId: ws._id, role: "member" },
    { userId: viewer._id, workspaceId: ws._id, role: "viewer" },
    { userId: noAvatar._id, workspaceId: ws._id, role: "member" },
  ]);
  form = await Form.create({ title: "Avatar form", workspaceId: ws._id, createdBy: owner._id, status: "published", fields: [] });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Event.collection.deleteMany({});
});

const activity = (u: any) => request(app).get(`/api/workspaces/${ws._id}/events`).set(as(u));
const audit = (u: any) => request(app).get(`/api/workspaces/${ws._id}/audit`).set(as(u));
const formEvents = (u: any) => request(app).get(`/api/forms/${form._id}/events`).set(as(u));
const byActor = (events: any[], id: any) => events.find((e) => e.actor.id === String(id));

describe("actor avatars on the event feeds", () => {
  it("Activity carries each actor's picture, for a plain viewer too (not just admins)", async () => {
    await seed(owner, "form.publish");
    await seed(member, "form.create");
    const res = await activity(viewer);
    expect(res.status).toBe(200);
    expect(byActor(res.body.events, owner._id).actor.avatarUrl).toBe("https://cdn.example.com/avatars/owner.png");
    expect(byActor(res.body.events, member._id).actor.avatarUrl).toBe("/avatars/04.svg");
  });

  it("an actor with no picture, or no account at all, has avatarUrl null (never missing or undefined)", async () => {
    await seed(noAvatar, "form.create");
    await seed(null, "response.submit");
    const res = await activity(owner);
    const rows: any[] = res.body.events;
    expect(rows).toHaveLength(2);
    for (const e of rows) expect(e.actor).toHaveProperty("avatarUrl", null);
    expect(rows.find((e) => e.actor.id === "")).toBeTruthy(); // the unauthenticated actor is still listed
  });

  it("the Audit Log carries them as well", async () => {
    await seed(owner, "form.publish");
    const res = await audit(owner);
    expect(res.status).toBe(200);
    expect(byActor(res.body.events, owner._id).actor.avatarUrl).toBe("https://cdn.example.com/avatars/owner.png");
  });

  it("and so does a form's own activity", async () => {
    await seed(member, "form.update");
    const res = await formEvents(owner);
    expect(res.status).toBe(200);
    expect(byActor(res.body.events, member._id).actor.avatarUrl).toBe("/avatars/04.svg");
  });

  it("a picture changed since the event is the current one (it is read at list time, not stored in the event)", async () => {
    await seed(member, "form.create");
    await User.updateOne({ _id: member._id }, { avatarUrl: "/avatars/07.svg" });
    const res = await activity(owner);
    expect(byActor(res.body.events, member._id).actor.avatarUrl).toBe("/avatars/07.svg");
    await User.updateOne({ _id: member._id }, { avatarUrl: "/avatars/04.svg" });
  });

  it("asks for the pictures of a whole page in one query, however many events there are", async () => {
    for (let i = 0; i < 15; i++) await seed(i % 2 ? owner : member, "form.update");
    const spy = jest.spyOn(User, "find");
    const res = await activity(owner);
    expect(res.body.events).toHaveLength(15);
    // other middleware may look users up too; the point is that listing events does not do one lookup per event
    const picturesLookups = spy.mock.calls.filter(([filter]: any[]) => filter && typeof filter === "object" && "_id" in filter && filter._id.$in);
    expect(picturesLookups.length).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });

  it("reads only the picture: nothing else about the user is sent", async () => {
    await seed(owner, "form.publish");
    const res = await activity(owner);
    const actor = byActor(res.body.events, owner._id).actor;
    expect(Object.keys(actor).sort()).toEqual(["avatarUrl", "email", "id", "name"]);
    expect(JSON.stringify(res.body)).not.toMatch(/firebaseUid|passwordHash|password|token/i);
  });

  it("keeps the same permissions: anonymous is refused, an outsider does not see another workspace's events", async () => {
    await seed(owner, "form.publish");
    expect((await request(app).get(`/api/workspaces/${ws._id}/events`)).status).toBe(401);
    const outsider = await User.create({ firebaseUid: "uid-av-out", fullName: "Out Sider", email: "out@av.test", status: "active" });
    const res = await activity(outsider);
    expect([403, 404]).toContain(res.status);
    expect(res.body.events).toBeUndefined();
  });

  it("an empty feed is still an empty list", async () => {
    const res = await activity(owner);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });
});
