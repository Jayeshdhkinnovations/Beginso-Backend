// QA A4b-002: a stale tab's autosave silently overwrote newer data. PATCH /api/forms/:id now takes an optional
// `expectedUpdatedAt`; a save based on an out-of-date copy is refused with 409 FORM_STALE and writes nothing.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-form-stale-write";

let mongoServer: MongoMemoryServer;
let owner: any;
let ws: any;

const patch = (formId: string, body: any, scope: "ws" | "personal" = "ws") => {
  const r = request(app)
    .patch(`/api/forms/${formId}`)
    .set("Authorization", `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role })}`);
  return (scope === "ws" ? r.set("x-workspace-id", ws._id.toString()) : r.set("x-workspace-slug", "personal")).send(body);
};
const mkForm = (extra: any = {}) =>
  Form.create({
    title: "Original",
    workspaceId: ws._id,
    createdBy: owner._id,
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
    ...extra,
  });
const pause = (ms = 15) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  owner = await User.create({ firebaseUid: "uid-stale-owner", fullName: "Stale Owner", email: "stale-owner@test.com", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "Stale WS", slug: "stale-ws", timezone: "UTC", owner: owner._id });
  owner.workspaceId = ws._id;
  await owner.save();
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("PATCH /api/forms/:id with expectedUpdatedAt", () => {
  it("saves when the version matches, returns the new updatedAt, and the next save must use it", async () => {
    const form = await mkForm();
    const v1 = (await Form.findById(form._id))!.updatedAt.toISOString();
    await pause();

    const first = await patch(form._id.toString(), { title: "One", expectedUpdatedAt: v1 });
    expect(first.status).toBe(200);
    const v2 = first.body.updatedAt;
    expect(new Date(v2).getTime()).toBeGreaterThan(new Date(v1).getTime());

    await pause();
    expect((await patch(form._id.toString(), { title: "Two", expectedUpdatedAt: v2 })).status).toBe(200); // own consecutive save
    expect((await Form.findById(form._id))!.title).toBe("Two");
  });

  it("refuses a stale save with 409 FORM_STALE, returns the current updatedAt, and changes nothing", async () => {
    const form = await mkForm();
    const old = (await Form.findById(form._id))!.updatedAt.toISOString();
    await pause();
    const newer = await patch(form._id.toString(), { title: "Tab A edit", expectedUpdatedAt: old });
    expect(newer.status).toBe(200);

    const stale = await patch(form._id.toString(), { title: "Tab B overwrite", expectedUpdatedAt: old });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("FORM_STALE");
    expect(stale.body.updatedAt).toBe(newer.body.updatedAt);

    const stored: any = await Form.findById(form._id).lean();
    expect(stored.title).toBe("Tab A edit"); // not overwritten
    expect(stored.expectedUpdatedAt).toBeUndefined(); // a precondition, never stored as data
  });

  it("still works with no expectedUpdatedAt (older clients)", async () => {
    const form = await mkForm();
    expect((await patch(form._id.toString(), { title: "No version" })).status).toBe(200);
    expect((await patch(form._id.toString(), { title: "Again" })).status).toBe(200);
  });

  it("rejects an unparseable expectedUpdatedAt with 400", async () => {
    const form = await mkForm();
    expect((await patch(form._id.toString(), { title: "x", expectedUpdatedAt: "not-a-date" })).status).toBe(400);
  });

  it("of two saves racing on the same version, exactly one wins", async () => {
    const form = await mkForm();
    const v = (await Form.findById(form._id))!.updatedAt.toISOString();
    await pause();
    const [a, b] = await Promise.all([
      patch(form._id.toString(), { title: "Racer A", expectedUpdatedAt: v }),
      patch(form._id.toString(), { title: "Racer B", expectedUpdatedAt: v }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? "Racer A" : "Racer B";
    expect((await Form.findById(form._id))!.title).toBe(winner);
  });

  it("works the same on a personal form", async () => {
    const form = await mkForm({ workspaceId: null });
    const v1 = (await Form.findById(form._id))!.updatedAt.toISOString();
    await pause();
    const ok = await patch(form._id.toString(), { title: "Mine", expectedUpdatedAt: v1 }, "personal");
    expect(ok.status).toBe(200);
    const stale = await patch(form._id.toString(), { title: "Old tab", expectedUpdatedAt: v1 }, "personal");
    expect(stale.status).toBe(409);
    expect((await Form.findById(form._id))!.title).toBe("Mine");
  });

  it("a form that no longer exists is still a 404, not a stale conflict", async () => {
    const form = await mkForm();
    const v = (await Form.findById(form._id))!.updatedAt.toISOString();
    await Form.deleteOne({ _id: form._id });
    expect((await patch(form._id.toString(), { title: "ghost", expectedUpdatedAt: v })).status).toBe(404);
  });
});
