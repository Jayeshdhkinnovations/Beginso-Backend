// Pinned forms: a private per-user bookmark. Pinning needs read access, never changes the form, and a pin
// can never show a form (or its title) the caller can no longer read.
process.env.JWT_SECRET = "test-jwt-secret-key-for-pinned-forms";
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
import FormPin from "../models/FormPin";
import FormAccessGrant from "../models/FormAccessGrant";
import { generateToken } from "../utils/generateToken";
import { FormService } from "../services/form.service";
import { PIN_LIMIT } from "../services/pin.service";

let mongoServer: MongoMemoryServer;
let owner: any, editor: any, viewer: any, outsider: any, grantee: any, otherOwner: any;
let t: Record<string, string>;
let wsA: any, wsB: any;

const token = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role || "user" });
const as = (tok: string, slug?: string) => ({ Authorization: `Bearer ${tok}`, ...(slug ? { "x-workspace-slug": slug } : {}) });
const pin = (tok: string, id: any, slug?: string) => request(app).put(`/api/forms/${id}/pin`).set(as(tok, slug));
const unpin = (tok: string, id: any, slug?: string) => request(app).delete(`/api/forms/${id}/pin`).set(as(tok, slug));
const list = (tok: string, qs = "", slug?: string) => request(app).get(`/api/forms?${qs}`).set(as(tok, slug));

let seq = 0;
const baseForm = (o: Record<string, any> = {}) => ({
  title: `Form ${++seq}`,
  workspaceId: wsA._id,
  createdBy: owner._id,
  status: "draft",
  fields: [{ fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: false }],
  pages: [{ id: "p1", order: 0, title: "Page" }],
  ...o,
});
const mkForm = (o: Record<string, any> = {}) => Form.create(baseForm(o) as any);

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Workspace.init(), Membership.init(), Form.init(), FormPin.init(), FormAccessGrant.init()]);

  const mk = (n: string) => User.create({ firebaseUid: `uid-pin-${n}`, fullName: `${n} P`, email: `${n}@pin.test`, status: "active" });
  [owner, editor, viewer, outsider, grantee, otherOwner] = await Promise.all(["owner", "editor", "viewer", "outsider", "grantee", "oo"].map(mk));
  t = { owner: token(owner), editor: token(editor), viewer: token(viewer), outsider: token(outsider), grantee: token(grantee), oo: token(otherOwner) };
  wsA = await Workspace.create({ name: "Pin A", owner: owner._id });
  wsB = await Workspace.create({ name: "Pin B", owner: otherOwner._id });
  await Membership.create([
    { userId: owner._id, workspaceId: wsA._id, role: "owner" },
    { userId: editor._id, workspaceId: wsA._id, role: "editor" },
    { userId: viewer._id, workspaceId: wsA._id, role: "viewer" },
    { userId: otherOwner._id, workspaceId: wsB._id, role: "owner" },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await FormPin.deleteMany({});
});

describe("pin / unpin", () => {
  it("pins, is idempotent, and unpins idempotently; the form itself is untouched", async () => {
    const f = await mkForm();
    const before = await Form.findById(f._id).lean();
    const a = await pin(t.viewer, f._id);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ success: true, pinned: true, formId: String(f._id) });
    const b = await pin(t.viewer, f._id);
    expect(b.status).toBe(200);
    expect(b.body.pinnedAt).toBe(a.body.pinnedAt);
    expect(await FormPin.countDocuments({ userId: viewer._id })).toBe(1);
    expect(await Form.findById(f._id).lean()).toEqual(before);

    expect((await unpin(t.viewer, f._id)).body).toMatchObject({ success: true, pinned: false });
    expect((await unpin(t.viewer, f._id)).status).toBe(200);
    expect(await FormPin.countDocuments({})).toBe(0);
  });

  it("rejects an invalid id (400) and never pins an unknown form", async () => {
    expect((await pin(t.owner, "nope")).status).toBe(400);
    const res = await pin(t.owner, new mongoose.Types.ObjectId(), wsA.slug);
    expect(res.status).toBe(404);
    expect(await FormPin.countDocuments({})).toBe(0);
  });

  it("is per user: one user's pin is invisible to another", async () => {
    const f = await mkForm();
    await pin(t.editor, f._id);
    const mine = await list(t.editor, "", wsA.slug);
    const theirs = await list(t.viewer, "", wsA.slug);
    expect(mine.body.forms.find((x: any) => x._id === String(f._id)).pinned).toBe(true);
    expect(theirs.body.forms.find((x: any) => x._id === String(f._id)).pinned).toBe(false);
    expect((await list(t.viewer, "pinned=true", wsA.slug)).body.forms).toHaveLength(0);
  });
});

describe("permissions", () => {
  it("viewer (read-only) may pin; outsider and cross-workspace users get 403", async () => {
    const f = await mkForm();
    expect((await pin(t.viewer, f._id)).status).toBe(200);
    expect((await pin(t.outsider, f._id)).status).toBe(403);
    expect((await pin(t.oo, f._id)).status).toBe(403);
    expect((await pin(t.oo, f._id, wsB.slug)).status).toBe(403);
    expect(await FormPin.countDocuments({ userId: { $in: [outsider._id, otherOwner._id] } })).toBe(0);
  });

  it("a grant-only user may pin, and may still unpin after the grant is revoked", async () => {
    const f = await mkForm();
    expect((await pin(t.grantee, f._id)).status).toBe(403);
    await FormAccessGrant.create({ formId: f._id, userId: grantee._id, role: "viewer" });
    expect((await pin(t.grantee, f._id)).status).toBe(200);
    await FormAccessGrant.deleteMany({ formId: f._id });
    expect((await unpin(t.grantee, f._id)).status).toBe(200);
    expect(await FormPin.countDocuments({})).toBe(0);
  });

  it("personal form: only the owner (or a grantee) may pin", async () => {
    const f = await mkForm({ workspaceId: null, createdBy: editor._id });
    expect((await pin(t.editor, f._id)).status).toBe(200);
    expect((await pin(t.viewer, f._id)).status).toBe(403);
    expect((await FormPin.findOne({ formId: f._id }).lean())!.workspaceId).toBeNull();
    await FormAccessGrant.create({ formId: f._id, userId: viewer._id, role: "reviewer" });
    expect((await pin(t.viewer, f._id)).status).toBe(200);
  });
});

describe("cap and form state", () => {
  it("allows PIN_LIMIT pins, then 400 PIN_LIMIT; re-pinning still 200; unpin frees a slot", async () => {
    const forms: any[] = await Form.insertMany(Array.from({ length: PIN_LIMIT + 1 }, () => baseForm()) as any);
    await FormPin.insertMany(forms.slice(0, PIN_LIMIT).map((f) => ({ userId: editor._id, formId: f._id, workspaceId: wsA._id })));
    const over = await pin(t.editor, forms[PIN_LIMIT]._id);
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("PIN_LIMIT");
    expect((await pin(t.editor, forms[0]._id)).status).toBe(200);
    await unpin(t.editor, forms[0]._id);
    expect((await pin(t.editor, forms[PIN_LIMIT]._id)).status).toBe(200);
  });

  it("stale pins (trashed forms) do not count toward the cap", async () => {
    const forms: any[] = await Form.insertMany(Array.from({ length: PIN_LIMIT }, () => baseForm({ deletedAt: new Date() })) as any);
    await FormPin.insertMany(forms.map((f) => ({ userId: editor._id, formId: f._id, workspaceId: wsA._id })));
    const f = await mkForm();
    expect((await pin(t.editor, f._id)).status).toBe(200);
  });

  it("trashed and archived forms cannot be newly pinned (409) and leave the default pinned list", async () => {
    const f = await mkForm();
    await pin(t.editor, f._id);
    await Form.updateOne({ _id: f._id }, { archivedAt: new Date() });
    expect((await list(t.editor, "pinned=true", wsA.slug)).body.forms).toHaveLength(0);
    expect((await list(t.editor, "pinned=true&archived=true", wsA.slug)).body.forms).toHaveLength(1);

    const g = await mkForm({ archivedAt: new Date() });
    const r = await pin(t.editor, g._id, wsA.slug);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("PIN_FORM_UNAVAILABLE");

    const h = await mkForm();
    await pin(t.editor, h._id);
    await Form.updateOne({ _id: h._id }, { deletedAt: new Date() });
    expect((await pin(t.editor, h._id, wsA.slug)).status).toBe(409);
    const ids = (await list(t.editor, "pinned=true&archived=true", wsA.slug)).body.forms.map((x: any) => x._id);
    expect(ids).not.toContain(String(h._id));
    // a trashed form's state is not revealed to someone who cannot read it
    expect((await pin(t.outsider, h._id, wsA.slug)).status).toBe(403);
  });
});

describe("list", () => {
  it("pinned=true: most recently pinned first, paginated, searchable, status-filtered", async () => {
    const a = await mkForm({ title: "Alpha survey" });
    const b = await mkForm({ title: "Beta survey", status: "published" });
    const c = await mkForm({ title: "Gamma poll" });
    await mkForm({ title: "Never pinned" });
    for (const f of [a, b, c]) {
      await pin(t.editor, f._id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const all = await list(t.editor, "pinned=true", wsA.slug);
    expect(all.body.forms.map((x: any) => x.title)).toEqual(["Gamma poll", "Beta survey", "Alpha survey"]);
    expect(all.body.total).toBe(3);
    expect(all.body.forms.every((x: any) => x.pinned === true && x.pinnedAt)).toBe(true);

    const p1 = await list(t.editor, "pinned=true&limit=2&page=1", wsA.slug);
    const p2 = await list(t.editor, "pinned=true&limit=2&page=2", wsA.slug);
    expect(p1.body.forms.map((x: any) => x.title)).toEqual(["Gamma poll", "Beta survey"]);
    expect(p2.body.forms.map((x: any) => x.title)).toEqual(["Alpha survey"]);
    expect(p1.body).toMatchObject({ total: 3, pages: 2 });

    expect((await list(t.editor, "pinned=true&search=survey", wsA.slug)).body.forms).toHaveLength(2);
    expect((await list(t.editor, "pinned=true&status=published", wsA.slug)).body.forms.map((x: any) => x.title)).toEqual(["Beta survey"]);
  });

  it("respects context scoping: workspace pins are not in personal or other-workspace lists", async () => {
    const wf = await mkForm({ title: "WS form" });
    const pf = await mkForm({ title: "Personal form", workspaceId: null, createdBy: editor._id });
    await pin(t.editor, wf._id);
    await pin(t.editor, pf._id);
    expect((await list(t.editor, "pinned=true", wsA.slug)).body.forms.map((x: any) => x.title)).toEqual(["WS form"]);
    expect((await list(t.editor, "pinned=true&workspaceId=personal")).body.forms.map((x: any) => x.title)).toEqual(["Personal form"]);
    expect((await list(t.oo, "pinned=true", wsB.slug)).body.forms).toHaveLength(0);
    expect((await list(t.outsider, "pinned=true", wsA.slug)).status).toBe(403);
  });

  it("every normal row carries pinned: boolean (pinnedAt only when pinned)", async () => {
    const a = await mkForm();
    const b = await mkForm();
    await pin(t.editor, a._id);
    const rows = (await list(t.editor, "", wsA.slug)).body.forms;
    const ra = rows.find((x: any) => x._id === String(a._id));
    const rb = rows.find((x: any) => x._id === String(b._id));
    expect(ra.pinned).toBe(true);
    expect(ra.pinnedAt).toBeTruthy();
    expect(rb.pinned).toBe(false);
    expect(rb.pinnedAt).toBeUndefined();
    expect(rows.every((x: any) => typeof x.pinned === "boolean")).toBe(true);
  });

  it("shared-with-me rows carry pinned", async () => {
    const f = await mkForm({ workspaceId: wsB._id, createdBy: otherOwner._id });
    await FormAccessGrant.create({ formId: f._id, userId: grantee._id, role: "viewer" });
    expect((await request(app).get("/api/shared-with-me").set(as(t.grantee))).body.forms[0].pinned).toBe(false);
    expect((await pin(t.grantee, f._id)).status).toBe(200);
    expect((await request(app).get("/api/shared-with-me").set(as(t.grantee))).body.forms[0].pinned).toBe(true);
  });
});

describe("access loss, purge and move", () => {
  it("a removed member no longer sees the pin and no title leaks", async () => {
    const f = await mkForm({ title: "Secret title" });
    await pin(t.viewer, f._id);
    await Membership.deleteOne({ userId: viewer._id, workspaceId: wsA._id });
    const res = await list(t.viewer, "pinned=true", wsA.slug);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("Secret title");
    expect((await list(t.viewer, "pinned=true&workspaceId=personal")).body.forms).toHaveLength(0);
    await Membership.create({ userId: viewer._id, workspaceId: wsA._id, role: "viewer" });
  });

  it("permanent purge removes every user's pin on the form", async () => {
    const f = await mkForm();
    await pin(t.editor, f._id);
    await pin(t.viewer, f._id);
    await new FormService().purgeForm(String(f._id));
    expect(await FormPin.countDocuments({ formId: f._id })).toBe(0);
  });

  it("moving to a workspace the pinner is not in drops the pin", async () => {
    const f = await mkForm();
    await pin(t.owner, f._id);
    await pin(t.editor, f._id);
    const res = await request(app).post(`/api/forms/${f._id}/move`).set(as(t.owner, wsA.slug)).send({ targetWorkspaceId: String(wsB._id) });
    // owner is not an admin of wsB, so the move itself is refused and pins are untouched
    expect(res.status).toBe(403);
    expect(await FormPin.countDocuments({ formId: f._id })).toBe(2);
  });

  it("moving to personal keeps only the mover's pin", async () => {
    const g = await mkForm();
    await pin(t.owner, g._id);
    await pin(t.editor, g._id);
    const res = await request(app).post(`/api/forms/${g._id}/move`).set(as(t.owner, wsA.slug)).send({ targetWorkspaceId: "personal" });
    expect(res.status).toBe(200);
    const left = await FormPin.find({ formId: g._id }).lean();
    expect(left.map((p) => String(p.userId))).toEqual([String(owner._id)]);
    expect(left[0].workspaceId).toBeNull();
    expect((await list(t.editor, "pinned=true", wsA.slug)).body.forms).toHaveLength(0);
  });

  it("moving between workspaces keeps destination members' pins and updates workspaceId", async () => {
    await Membership.create({ userId: owner._id, workspaceId: wsB._id, role: "admin" });
    const f = await mkForm();
    await pin(t.owner, f._id);
    await pin(t.editor, f._id);
    const res = await request(app).post(`/api/forms/${f._id}/move`).set(as(t.owner, wsA.slug)).send({ targetWorkspaceId: String(wsB._id) });
    expect(res.status).toBe(200);
    const left = await FormPin.find({ formId: f._id }).lean();
    expect(left.map((p) => String(p.userId))).toEqual([String(owner._id)]);
    expect(String(left[0].workspaceId)).toBe(String(wsB._id));
    await Membership.deleteOne({ userId: owner._id, workspaceId: wsB._id });
  });
});
