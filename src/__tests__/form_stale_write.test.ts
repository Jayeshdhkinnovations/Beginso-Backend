// QA A4b-002: a stale tab's autosave silently overwrote newer data. PATCH /api/forms/:id takes an optional
// `expectedContentVersion` (+ a `saveId` so a retry is recognised). A save based on an out-of-date copy is refused with
// 409 FORM_STALE and writes nothing. The version moves ONLY when builder content changes: a respondent opening or
// answering the form, an auto-close, an archive or a new link must never make the owner's next autosave conflict.
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
const mkForm = (extra: any = {}) => {
  return Form.create({
    title: "Original",
    workspaceId: ws._id,
    createdBy: owner._id,
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
    ...extra,
  });
};
const stored = async (id: any): Promise<any> => Form.findById(id).lean();

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

describe("PATCH /api/forms/:id with expectedContentVersion", () => {
  it("saves when the version matches, returns the next version, and the next save must use it", async () => {
    const form = await mkForm();
    const first = await patch(form._id.toString(), { title: "One", expectedContentVersion: 0, saveId: "s1" });
    expect(first.status).toBe(200);
    expect(first.body.contentVersion).toBe(1);
    const second = await patch(form._id.toString(), { title: "Two", expectedContentVersion: 1, saveId: "s2" }); // own consecutive save
    expect(second.status).toBe(200);
    expect(second.body.contentVersion).toBe(2);
    expect((await stored(form._id)).title).toBe("Two");
  });

  it("refuses a stale save with 409 FORM_STALE, returns the current version, and changes nothing", async () => {
    const form = await mkForm();
    await patch(form._id.toString(), { title: "Tab A edit", expectedContentVersion: 0, saveId: "a" });

    const stale = await patch(form._id.toString(), { title: "Tab B overwrite", expectedContentVersion: 0, saveId: "b" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("FORM_STALE");
    expect(stale.body.contentVersion).toBe(1);

    const doc = await stored(form._id);
    expect(doc.title).toBe("Tab A edit"); // not overwritten
    expect(doc.contentVersion).toBe(1);
    expect(doc.expectedContentVersion).toBeUndefined(); // a precondition, never stored as data
    expect(doc.saveId).toBeUndefined();
  });

  it("still works with no expectedContentVersion (older clients)", async () => {
    const form = await mkForm();
    expect((await patch(form._id.toString(), { title: "No version" })).status).toBe(200);
    expect((await patch(form._id.toString(), { title: "Again" })).status).toBe(200);
  });

  it("rejects a malformed version with 400", async () => {
    const form = await mkForm();
    expect((await patch(form._id.toString(), { title: "x", expectedContentVersion: "one" })).status).toBe(400);
    expect((await patch(form._id.toString(), { title: "x", expectedContentVersion: -1 })).status).toBe(400);
  });

  it("of two saves racing on the same version, exactly one wins", async () => {
    const form = await mkForm();
    const [a, b] = await Promise.all([
      patch(form._id.toString(), { title: "Racer A", expectedContentVersion: 0, saveId: "ra" }),
      patch(form._id.toString(), { title: "Racer B", expectedContentVersion: 0, saveId: "rb" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await stored(form._id)).title).toBe(a.status === 200 ? "Racer A" : "Racer B");
    expect((await stored(form._id)).contentVersion).toBe(1);
  });

  it("works the same on a personal form", async () => {
    const form = await mkForm({ workspaceId: null });
    expect((await patch(form._id.toString(), { title: "Mine", expectedContentVersion: 0, saveId: "p1" }, "personal")).status).toBe(200);
    expect((await patch(form._id.toString(), { title: "Old tab", expectedContentVersion: 0, saveId: "p2" }, "personal")).status).toBe(409);
    expect((await stored(form._id)).title).toBe("Mine");
  });

  it("a form that no longer exists is still a 404, not a stale conflict", async () => {
    const form = await mkForm();
    await Form.deleteOne({ _id: form._id });
    expect((await patch(form._id.toString(), { title: "ghost", expectedContentVersion: 0, saveId: "g" })).status).toBe(404);
  });

  it("treats a form saved before the counter existed as version 0", async () => {
    const form = await mkForm();
    await Form.collection.updateOne({ _id: form._id }, { $unset: { contentVersion: "" } });
    const res = await patch(form._id.toString(), { title: "Legacy", expectedContentVersion: 0, saveId: "l1" });
    expect(res.status).toBe(200);
    expect(res.body.contentVersion).toBe(1);
  });
});

describe("a retry whose first reply was lost", () => {
  it("is recognised by its saveId and answered with success, without applying the edit twice", async () => {
    const form = await mkForm();
    const first = await patch(form._id.toString(), { title: "Edit", expectedContentVersion: 0, saveId: "same" });
    expect(first.status).toBe(200); // the client never saw this reply

    const retry = await patch(form._id.toString(), { title: "Edit", expectedContentVersion: 0, saveId: "same" });
    expect(retry.status).toBe(200);
    expect(retry.body.contentVersion).toBe(1); // not 2: nothing was applied again
    expect((await stored(form._id)).contentVersion).toBe(1);
  });

  it("is NOT confused with another tab's save that has a different saveId", async () => {
    const form = await mkForm();
    await patch(form._id.toString(), { title: "Tab A", expectedContentVersion: 0, saveId: "tabA" });
    const other = await patch(form._id.toString(), { title: "Tab B", expectedContentVersion: 0, saveId: "tabB" });
    expect(other.status).toBe(409);
  });
});

describe("things that are NOT builder edits never cause a false conflict", () => {
  const publishedForm = async (slug: string) =>
    mkForm({ status: "published", slug, publishedSlug: slug });

  it("a respondent opening the public form (view count)", async () => {
    const form = await publishedForm("stale-view-form");
    const before = await stored(form._id);
    expect((await request(app).post("/api/public/stale-view-form/view").set({ "x-forwarded-for": "10.9.9.1" })).status).toBe(204);
    const after = await stored(form._id);
    expect(after.viewsCount).toBe((before.viewsCount ?? 0) + 1);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime()); // updatedAt DID move: why it cannot be the check
    expect(after.contentVersion ?? 0).toBe(before.contentVersion ?? 0);
    expect((await patch(form._id.toString(), { title: "Owner keeps typing", expectedContentVersion: 0, saveId: "v1" })).status).toBe(200);
  });

  it("a respondent submitting a response", async () => {
    const form = await publishedForm("stale-submit-form");
    const res = await request(app).post("/api/public/stale-submit-form/submit").send({ f1: "Anon" });
    expect(res.status).toBe(200);
    expect((await patch(form._id.toString(), { title: "Still typing", expectedContentVersion: 0, saveId: "s1" })).status).toBe(200);
  });

  it("an automatic close, an archive and a new public link", async () => {
    const form = await publishedForm("stale-status-form");
    await Form.updateOne({ _id: form._id }, { status: "closed" }); // what the response-limit / close-date writers do
    await Form.updateOne({ _id: form._id }, { archivedAt: new Date() });
    await Form.updateOne({ _id: form._id }, { publishedSlug: "stale-status-form-2" });
    expect((await stored(form._id)).contentVersion ?? 0).toBe(0);
    expect((await patch(form._id.toString(), { title: "Edited after all that", expectedContentVersion: 0, saveId: "z" })).status).toBe(200);
  });

  it("but a content change from somewhere else (a rename) does count", async () => {
    const form = await mkForm();
    expect((await patch(form._id.toString(), { title: "Renamed elsewhere" })).status).toBe(200); // unversioned writer, e.g. an older client
    const stale = await patch(form._id.toString(), { title: "This tab's old copy", expectedContentVersion: 0, saveId: "late" });
    expect(stale.status).toBe(409);
  });
});
