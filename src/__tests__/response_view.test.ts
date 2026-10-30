// Response layouts (Sprint 15): the per-user choice, the form default, the resolved view, and the field schema that
// the response detail now carries. Hiding or pinning a field in a view is cosmetic and never touches response data.
process.env.JWT_SECRET = "test-jwt-secret-key-for-response-view";
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
import ResponseModel from "../models/Response";
import ResponseViewDefault from "../models/ResponseViewDefault";
import UserResponseViewPref from "../models/UserResponseViewPref";
import FormAccessGrant from "../models/FormAccessGrant";
import { generateToken } from "../utils/generateToken";
import { pickView, SYSTEM_DEFAULT } from "../services/responseView.service";
import { startInFreshWindow } from "./helpers/freshWindow";

let mongoServer: MongoMemoryServer;
let owner: any, admin: any, editor: any, viewer: any, outsider: any, grantee: any, other: any;
let t: Record<string, string>;
let ws: any;

const token = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role || "user" });
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });

const GRID = { layout: "grid", density: "comfortable", showEmpty: true, showNumbers: true } as const;
const LIST = { layout: "list", density: "compact", showEmpty: false, showNumbers: false } as const;
const TABLE = { layout: "table", density: "comfortable", showEmpty: true, showNumbers: false } as const;

const getView = (tok: string, formId: any) => request(app).get(`/api/forms/${formId}/response-view`).set(as(tok));
const putMine = (tok: string, body: any) => request(app).put("/api/me/response-view").set(as(tok)).send(body);
const delMine = (tok: string, scope: string) => request(app).delete(`/api/me/response-view?scope=${scope}`).set(as(tok));
const putDefault = (tok: string, formId: any, body: any) => request(app).put(`/api/forms/${formId}/response-view-default`).set(as(tok)).send(body);

let seq = 0;
const mkForm = (o: Record<string, any> = {}) =>
  Form.create({
    title: `View form ${++seq}`,
    workspaceId: ws._id,
    createdBy: owner._id,
    status: "draft",
    fields: [{ fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: false, order: 0 }],
    pages: [{ id: "p1", order: 0, title: "Page" }],
    ...o,
  } as any);

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Workspace.init(), Membership.init(), Form.init(), ResponseViewDefault.init(), UserResponseViewPref.init(), FormAccessGrant.init()]);

  const mk = (n: string) => User.create({ firebaseUid: `uid-rv-${n}`, fullName: `${n} V`, email: `${n}@rv.test`, status: "active" });
  [owner, admin, editor, viewer, outsider, grantee, other] = await Promise.all(["owner", "admin", "editor", "viewer", "outsider", "grantee", "other"].map(mk));
  t = Object.fromEntries(Object.entries({ owner, admin, editor, viewer, outsider, grantee, other }).map(([k, u]) => [k, token(u)]));
  ws = await Workspace.create({ name: "View WS", owner: owner._id });
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
  await Promise.all([ResponseViewDefault.deleteMany({}), UserResponseViewPref.deleteMany({})]);
});

describe("pickView (the one precedence rule)", () => {
  const P = { ...LIST } as any, A = { ...TABLE } as any, D = { layout: "list", density: "comfortable", showEmpty: true, showNumbers: true } as any;

  it("personal form > personal all > form default > system, each level missing in turn", () => {
    expect(pickView(P, A, D)).toMatchObject({ source: "personal", layout: "list", density: "compact" });
    expect(pickView(null, A, D)).toMatchObject({ source: "personalAll", layout: "table" });
    expect(pickView(null, null, D)).toMatchObject({ source: "formDefault", layout: "list", density: "comfortable" });
    expect(pickView(null, null, null)).toMatchObject({ source: "system", ...SYSTEM_DEFAULT });
    expect(pickView(P, null, null).source).toBe("personal");
    expect(pickView(P, A, null).source).toBe("personal");
    expect(pickView(null, A, null).source).toBe("personalAll");
  });

  it("never mixes settings between levels", () => {
    const r = pickView({ ...GRID, density: "compact" } as any, { ...LIST } as any, null);
    expect(r).toMatchObject({ layout: "grid", density: "compact", showEmpty: true, showNumbers: true });
  });
});

describe("GET /forms/:formId/response-view", () => {
  it("resolves through the API in the documented order as choices are added and cleared", async () => {
    const f = await mkForm();
    const r0 = await getView(t.viewer, f._id);
    expect(r0.status).toBe(200);
    expect(r0.body).toMatchObject({ success: true, resolved: { source: "system", ...SYSTEM_DEFAULT }, formDefault: null, personal: null, personalAll: null });

    expect((await putDefault(t.editor, f._id, { expectedVersion: 0, ...TABLE })).status).toBe(200);
    expect((await getView(t.viewer, f._id)).body.resolved).toMatchObject({ source: "formDefault", layout: "table" });

    expect((await putMine(t.viewer, { scope: "all", ...LIST })).status).toBe(200);
    expect((await getView(t.viewer, f._id)).body.resolved).toMatchObject({ source: "personalAll", layout: "list" });

    expect((await putMine(t.viewer, { scope: String(f._id), ...GRID })).status).toBe(200);
    const full = (await getView(t.viewer, f._id)).body;
    expect(full.resolved).toMatchObject({ source: "personal", layout: "grid" });
    expect(full.personal.scope).toBe(String(f._id));
    expect(full.personalAll.layout).toBe("list");
    // someone else is unaffected by the viewer's personal choices
    expect((await getView(t.editor, f._id)).body.resolved).toMatchObject({ source: "formDefault", layout: "table" });

    expect((await delMine(t.viewer, String(f._id))).body).toMatchObject({ success: true, cleared: true });
    expect((await getView(t.viewer, f._id)).body.resolved.source).toBe("personalAll");
    await delMine(t.viewer, "all");
    expect((await getView(t.viewer, f._id)).body.resolved.source).toBe("formDefault");
  });

  it("a personal choice for one form never leaks to another form", async () => {
    const a = await mkForm();
    const b = await mkForm();
    await putMine(t.viewer, { scope: String(a._id), ...LIST });
    expect((await getView(t.viewer, b._id)).body.resolved.source).toBe("system");
  });

  it("permission matrix: members read it; outsiders and anonymous callers do not", async () => {
    const f = await mkForm();
    for (const who of ["owner", "admin", "editor", "viewer"]) expect((await getView(t[who], f._id)).status).toBe(200);
    expect((await getView(t.outsider, f._id)).status).toBe(403);
    expect((await request(app).get(`/api/forms/${f._id}/response-view`)).status).toBe(401);
    expect((await getView(t.owner, "not-an-id")).status).toBe(400);
    expect((await getView(t.owner, new mongoose.Types.ObjectId())).status).toBe(404);
  });

  it("a per-form grant opens the read", async () => {
    const f = await mkForm();
    await FormAccessGrant.create({ formId: f._id, userId: grantee._id, role: "viewer" });
    expect((await getView(t.grantee, f._id)).status).toBe(200);
  });

  it("a personal form is readable only by its creator", async () => {
    const f = await mkForm({ workspaceId: null, createdBy: owner._id });
    expect((await getView(t.owner, f._id)).status).toBe(200);
    expect((await getView(t.other, f._id)).status).toBe(403);
  });

  it("drops field ids that no longer exist and reports them; never returns internal fields", async () => {
    const f = await mkForm({
      fields: [
        { fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", order: 0 },
        { fieldId: "f2", pageId: "p1", label: "Gone", type: "short_text", order: 1, deleted: true },
      ],
    });
    await ResponseViewDefault.create({
      formId: f._id, workspaceId: ws._id, ...GRID, updatedBy: owner._id, version: 3,
      pinned: ["f1", "f2", "ghost"],
      fields: [{ fieldId: "f1", hidden: true }, { fieldId: "f2", hidden: true }],
    });
    const body = (await getView(t.viewer, f._id)).body;
    expect(body.formDefault.pinned).toEqual(["f1"]);
    expect(body.formDefault.fields.map((x: any) => x.fieldId)).toEqual(["f1"]);
    expect(body.dropped.sort()).toEqual(["f2", "ghost"]);
    expect(body.formDefault.version).toBe(3);
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/__v|"_id"|workspaceId|token|password/i);
  });
});

describe("PUT /me/response-view and DELETE", () => {
  it("rejects unknown layouts (including sections and form), bad values and extra keys with 400", async () => {
    const f = await mkForm();
    for (const layout of ["sections", "form", "GRID", "", "cards", 1, null]) {
      expect((await putMine(t.viewer, { scope: "all", ...GRID, layout })).status).toBe(400);
      expect((await putDefault(t.owner, f._id, { expectedVersion: 0, ...GRID, layout })).status).toBe(400);
    }
    expect((await putMine(t.viewer, { scope: "all", ...GRID, density: "huge" })).status).toBe(400);
    expect((await putMine(t.viewer, { scope: "all", ...GRID, showEmpty: "yes" })).status).toBe(400);
    expect((await putMine(t.viewer, { scope: "nope", ...GRID })).status).toBe(400);
    expect((await putMine(t.viewer, { scope: "all", ...GRID, pinned: ["f1"] })).status).toBe(400);
    expect((await putMine(t.viewer, { scope: "all", layout: "grid" })).status).toBe(400);
    expect(await UserResponseViewPref.countDocuments({})).toBe(0);
    expect(await ResponseViewDefault.countDocuments({})).toBe(0);
  });

  it("is an upsert: one row per (user, scope), updated in place", async () => {
    await putMine(t.viewer, { scope: "all", ...GRID });
    await putMine(t.viewer, { scope: "all", ...TABLE });
    expect(await UserResponseViewPref.countDocuments({ userId: viewer._id })).toBe(1);
    expect((await UserResponseViewPref.findOne({ userId: viewer._id }).lean())!.layout).toBe("table");
  });

  it("scope = a form needs access to that form; an outsider is refused and nothing is stored", async () => {
    const f = await mkForm();
    expect((await putMine(t.outsider, { scope: String(f._id), ...LIST })).status).toBe(403);
    expect((await putMine(t.outsider, { scope: String(new mongoose.Types.ObjectId()), ...LIST })).status).toBe(404);
    expect(await UserResponseViewPref.countDocuments({ userId: outsider._id })).toBe(0);
    // "all" is the caller's own setting and needs no form
    expect((await putMine(t.outsider, { scope: "all", ...LIST })).status).toBe(200);
  });

  it("clearing is idempotent, touches only the caller's own row, and needs no form access", async () => {
    await putMine(t.viewer, { scope: "all", ...LIST });
    await putMine(t.editor, { scope: "all", ...TABLE });
    expect((await delMine(t.viewer, "all")).status).toBe(200);
    expect((await delMine(t.viewer, "all")).status).toBe(200);
    expect(await UserResponseViewPref.countDocuments({ userId: editor._id })).toBe(1);
    expect((await delMine(t.viewer, "bad scope")).status).toBe(400);
  });

  it("is rate limited per user on writes", async () => {
    await startInFreshWindow([60_000]); // the limiter counts in fixed one-minute windows: a burst across a boundary starts a new count
    process.env.USER_RATE_LIMIT_MAX = "3";
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await putMine(t.other, { scope: "all", ...GRID })).status);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    } finally {
      delete process.env.USER_RATE_LIMIT_MAX;
    }
  });
});

describe("PUT /forms/:formId/response-view-default", () => {
  it("permission matrix: editors and above set it; viewers and outsiders cannot", async () => {
    const f = await mkForm();
    expect((await putDefault(t.viewer, f._id, { expectedVersion: 0, ...LIST })).status).toBe(403);
    expect((await putDefault(t.outsider, f._id, { expectedVersion: 0, ...LIST })).status).toBe(403);
    expect((await request(app).put(`/api/forms/${f._id}/response-view-default`).send({ expectedVersion: 0, ...LIST })).status).toBe(401);
    expect(await ResponseViewDefault.countDocuments({})).toBe(0);
    expect((await putDefault(t.editor, f._id, { expectedVersion: 0, ...LIST })).status).toBe(200);
    expect((await putDefault(t.admin, f._id, { expectedVersion: 1, ...TABLE })).status).toBe(200);
    expect((await putDefault(t.owner, f._id, { expectedVersion: 2, ...GRID })).status).toBe(200);
  });

  it("a viewer-role per-form grant cannot set the default either", async () => {
    const f = await mkForm();
    await FormAccessGrant.create({ formId: f._id, userId: grantee._id, role: "viewer" });
    expect((await putDefault(t.grantee, f._id, { expectedVersion: 0, ...LIST })).status).toBe(403);
  });

  it("refuses a stale save with 409 and the current version, and keeps the newer data", async () => {
    const f = await mkForm();
    const first = await putDefault(t.editor, f._id, { expectedVersion: 0, ...LIST });
    expect(first.body.formDefault.version).toBe(1);
    const second = await putDefault(t.owner, f._id, { expectedVersion: 1, ...TABLE });
    expect(second.body.formDefault.version).toBe(2);

    const stale = await putDefault(t.editor, f._id, { expectedVersion: 1, ...GRID });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ success: false, version: 2, error: { code: "RESPONSE_VIEW_STALE" } });
    const create = await putDefault(t.editor, f._id, { expectedVersion: 0, ...GRID });
    expect(create.status).toBe(409);
    expect((await ResponseViewDefault.findOne({ formId: f._id }).lean())!.layout).toBe("table");
  });

  it("two concurrent first saves: exactly one wins", async () => {
    const f = await mkForm();
    const [a, b] = await Promise.all([
      putDefault(t.editor, f._id, { expectedVersion: 0, ...LIST }),
      putDefault(t.owner, f._id, { expectedVersion: 0, ...TABLE }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await ResponseViewDefault.countDocuments({ formId: f._id })).toBe(1);
  });

  it("changes only the view: the form's fields and content version are untouched", async () => {
    const f = await mkForm();
    const before = await Form.findById(f._id).lean();
    await putDefault(t.editor, f._id, { expectedVersion: 0, ...LIST });
    const after = await Form.findById(f._id).lean();
    expect(after!.fields).toEqual(before!.fields);
    expect(after!.contentVersion).toEqual(before!.contentVersion);
  });
});

describe("GET /responses/:id carries the form's field schema", () => {
  const detail = (tok: string, id: any) => request(app).get(`/api/responses/${id}`).set(as(tok));

  it("returns live questions in form order, answers by fieldId, and removed questions' answers separately", async () => {
    const f = await mkForm({
      pages: [{ id: "p2", order: 1, title: "Two" }, { id: "p1", order: 0, title: "One" }],
      fields: [
        { fieldId: "fb", pageId: "p2", label: "Comment", type: "long_text", order: 0, required: true },
        { fieldId: "fa", pageId: "p1", label: "Comment", type: "short_text", order: 1 },
        { fieldId: "fu", pageId: "p1", label: "Poster", type: "file_upload", order: 0 },
        { fieldId: "fc", pageId: "p1", label: "Colour", type: "dropdown", order: 2, options: ["Red", "Blue"] },
        { fieldId: "f_city", pageId: "p1", label: "City", type: "short_text", order: 3 },
        { fieldId: "fx", pageId: "p1", label: "Removed question", type: "short_text", order: 4, deleted: true },
      ],
    });
    const r: any = await ResponseModel.create({
      formId: f._id,
      answers: {
        Comment: "first holder",
        "Comment (2)": "second holder",
        Poster: "uploads/internal/storage-ref.pdf",
        Colour: "Blue",
        f_city: "Pune", // older data keyed by field id
        "Removed question": "kept, not lost",
        "Renamed long ago": "orphan",
      },
    });
    const res = await detail(t.viewer, r._id);
    expect(res.status).toBe(200);
    const body = res.body.response;

    expect(body.formSchema.fields.map((x: any) => x.fieldId)).toEqual(["fa", "fu", "fc", "f_city", "fb"]);
    expect(body.formSchema.fields.map((x: any) => x.order)).toEqual([0, 1, 2, 3, 4]);
    expect(body.formSchema.fields.find((x: any) => x.fieldId === "fc")).toMatchObject({ type: "dropdown", label: "Colour", options: ["Red", "Blue"], required: false });
    expect(body.formSchema.fields.find((x: any) => x.fieldId === "fb").required).toBe(true);

    // duplicate labels: each question gets its own answer; the first in the form's field array owns the plain label
    expect(body.answersByFieldId.fb).toBe("first holder");
    expect(body.answersByFieldId.fa).toBe("second holder");
    expect(body.answersByFieldId.fc).toBe("Blue");
    expect(body.answersByFieldId.f_city).toBe("Pune");
    // the stored file reference never leaks
    expect(body.answersByFieldId.fu).toBeUndefined();
    expect(JSON.stringify(body.answersByFieldId)).not.toContain("storage-ref");

    expect(body.orphanAnswers).toEqual(
      expect.arrayContaining([
        { key: "Removed question", label: "Removed question", value: "kept, not lost" },
        { key: "Renamed long ago", label: "Renamed long ago", value: "orphan" },
      ])
    );
    expect(body.orphanAnswers.map((o: any) => o.key)).not.toContain("Comment");
    expect(body.orphanAnswers.map((o: any) => o.key)).not.toContain("f_city");
    // the existing label-keyed answers are unchanged
    expect(body.answers.Comment).toBe("first holder");
  });

  it("still refuses a caller who cannot read the response", async () => {
    const f = await mkForm();
    const r: any = await ResponseModel.create({ formId: f._id, answers: { Name: "x" } });
    expect((await detail(t.outsider, r._id)).status).toBe(403);
  });
});
