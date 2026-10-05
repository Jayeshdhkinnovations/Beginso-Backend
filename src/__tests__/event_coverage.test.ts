// Sprint 10 / B7: every workspace mutation leaves an audit event (F5 / C3.6).
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));
// Report generation runs in the background after the response; only the audit event matters here.
jest.mock("../services/report.service", () => ({ generateReportAsync: async () => {} }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import crypto from "crypto";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Invitation from "../models/Invitation";
import FormAccessGrant from "../models/FormAccessGrant";
import { Event } from "../models/Event";
import Template from "../models/Template";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-event-coverage-suite";

let mongoServer: MongoMemoryServer;
let owner: any;
let invitee: any;
let wsA: any;
let wsC: any;

const tok = (u: any) => generateToken({ id: u._id.toString(), email: u.email, role: u.role });
const as = (r: request.Test, u: any = owner) => r.set("Authorization", `Bearer ${tok(u)}`).set("x-workspace-id", wsA._id.toString());
const mkForm = (extra: any = {}) =>
  Form.create({
    title: `form-${crypto.randomBytes(3).toString("hex")}`,
    workspaceId: wsA._id,
    createdBy: owner._id,
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
    ...extra,
  });
const eventsFor = (action: string, ws: any = wsA) => Event.find({ action, workspaceId: ws._id }).lean();

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Workspace, Membership, Form, ResponseModel, Invitation, FormAccessGrant, Event].map((m: any) => m.init()));

  owner = await User.create({ firebaseUid: "uid-ev-owner", fullName: "Event Owner", email: "ev-owner@test.com", role: "admin", status: "active" });
  invitee = await User.create({ firebaseUid: "uid-ev-invitee", fullName: "Invitee", email: "ev-invitee@test.com", role: "admin", status: "active" });
  wsA = await Workspace.create({ name: "Events A", slug: "events-a", timezone: "UTC", owner: owner._id });
  wsC = await Workspace.create({ name: "Events C", slug: "events-c", timezone: "UTC", owner: owner._id });
  owner.workspaceId = wsA._id;
  await owner.save();
  await Membership.create([
    { userId: owner._id, workspaceId: wsA._id, role: "owner" },
    { userId: owner._id, workspaceId: wsC._id, role: "owner" },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("event rows", () => {
  it("record the actor, the target and a hashed (never raw) IP", async () => {
    const res = await as(request(app).post("/api/forms").send({ title: "Audited form", fields: [{ label: "Q", type: "short_text", required: false }] }));
    expect(res.status).toBe(201);
    const [ev] = await eventsFor("form.create");
    expect(ev.actorEmail).toBe("ev-owner@test.com");
    expect(ev.actorId?.toString()).toBe(owner._id.toString());
    expect(ev.targetId).toBe(res.body._id);
    expect(ev.targetType).toBe("form");
    expect(ev.targetLabel).toBe("Audited form");
    expect(ev.ip).toMatch(/^[0-9a-f]{64}$/);
  });

  it("are indexed for the workspace feed and the per-form feed", async () => {
    const keys = (await Event.collection.indexes()).map((i: any) => JSON.stringify(i.key));
    expect(keys).toContain(JSON.stringify({ workspaceId: 1, createdAt: -1 }));
    expect(keys).toContain(JSON.stringify({ targetId: 1, createdAt: -1 }));
  });
});

describe("forms", () => {
  it("publish, close and unpublish", async () => {
    const f = await mkForm();
    await as(request(app).post(`/api/forms/${f._id}/publish`));
    await as(request(app).post(`/api/forms/${f._id}/close`));
    await as(request(app).patch(`/api/forms/${f._id}`).send({ status: "draft" }));
    expect((await Event.find({ action: "form.publish", targetId: f._id.toString() })).length).toBe(1);
    expect((await Event.find({ action: "form.close", targetId: f._id.toString() })).length).toBe(1);
    expect((await Event.find({ action: "form.unpublish", targetId: f._id.toString() })).length).toBe(1);
  });

  it("publishing through PATCH is recorded once", async () => {
    const f = await mkForm();
    await as(request(app).patch(`/api/forms/${f._id}`).send({ status: "published" }));
    expect((await Event.find({ action: "form.publish", targetId: f._id.toString() })).length).toBe(1);
  });

  it("duplicate and delete", async () => {
    const f = await mkForm();
    const dup = await as(request(app).post(`/api/forms/${f._id}/duplicate`));
    expect(dup.status).toBe(201);
    const [d] = await Event.find({ action: "form.duplicate", targetId: dup.body._id }).lean();
    expect(d.metadata?.sourceFormId).toBe(f._id.toString());
    await as(request(app).delete(`/api/forms/${f._id}`));
    // Sprint 13: deleting a form moves it to Trash and is audited as form.trash.
    expect((await Event.find({ action: "form.trash", targetId: f._id.toString() })).length).toBe(1);
  });

  it("move between workspaces and out to personal", async () => {
    const f = await mkForm();
    await as(request(app).post(`/api/forms/${f._id}/move`).send({ targetWorkspaceId: wsC._id.toString() }));
    const [toC] = await Event.find({ action: "form.move", targetId: f._id.toString() }).sort({ createdAt: 1 }).lean();
    expect(toC.workspaceId.toString()).toBe(wsA._id.toString());
    expect(toC.metadata?.to).toBe(wsC._id.toString());

    await request(app)
      .post(`/api/forms/${f._id}/move`)
      .set("Authorization", `Bearer ${tok(owner)}`)
      .set("x-workspace-id", wsC._id.toString())
      .send({ targetWorkspaceId: "personal" });
    const moves = await Event.find({ action: "form.move", targetId: f._id.toString() }).lean();
    expect(moves.some((m: any) => m.metadata?.to === "personal" && m.workspaceId.toString() === wsC._id.toString())).toBe(true);
  });

  it("creating from a template", async () => {
    const t = await Template.create({ name: "T", category: "G", theme: "light", isActive: true, fields: [] });
    const res = await as(request(app).post(`/api/templates/${t._id}/use`).send({ destinationWorkspaceId: wsA._id.toString() }));
    expect(res.status).toBe(201);
    const [ev] = await Event.find({ action: "form.create", targetId: res.body.data._id }).lean();
    expect(ev.metadata?.templateId).toBe(t._id.toString());
  });

  it("access grants: create and revoke", async () => {
    const f = await mkForm();
    const created = await as(request(app).post(`/api/forms/${f._id}/grants`).send({ userId: invitee._id.toString(), role: "viewer" }));
    expect(created.status).toBe(201);
    await as(request(app).delete(`/api/forms/${f._id}/grants/${invitee._id}`));
    const [c] = await Event.find({ action: "access_grant.create", "metadata.formId": f._id.toString() }).lean();
    expect(c.targetLabel).toBe("ev-invitee@test.com");
    expect(c.metadata?.role).toBe("viewer");
    expect((await Event.find({ action: "access_grant.revoke", "metadata.formId": f._id.toString() })).length).toBe(1);
  });

  it("form autosave (PATCH title/fields) does NOT write an event", async () => {
    const f = await mkForm();
    const before = await Event.countDocuments({ targetId: f._id.toString() });
    const res = await as(request(app).patch(`/api/forms/${f._id}`).send({ title: "Autosaved title" }));
    expect(res.status).toBe(200);
    expect(await Event.countDocuments({ targetId: f._id.toString() })).toBe(before);
  });

  it("a personal form (no workspace) writes no workspace event", async () => {
    const before = await Event.countDocuments({});
    const res = await request(app)
      .post("/api/forms")
      .set("Authorization", `Bearer ${tok(owner)}`)
      .set("x-workspace-id", "personal")
      .send({ title: "Personal one", fields: [{ label: "Q", type: "short_text", required: false }] });
    expect(res.status).toBe(201);
    expect(await Event.countDocuments({})).toBe(before);
  });
});

describe("responses and reports", () => {
  it("response status change and delete", async () => {
    const f = await mkForm();
    const r = await ResponseModel.create({ formId: f._id, answers: {} });
    await as(request(app).patch(`/api/responses/${r._id}`).send({ status: "in_progress" }));
    await as(request(app).delete(`/api/responses/${r._id}`));
    const [s] = await Event.find({ action: "response.status_change", targetId: r._id.toString() }).lean();
    expect(s.metadata?.status).toBe("in_progress");
    expect((await Event.find({ action: "response.delete", targetId: r._id.toString() })).length).toBe(1);
  });

  it("report creation", async () => {
    const res = await as(request(app).post("/api/reports").send({ format: "csv" }));
    expect(res.status).toBe(202);
    const [ev] = await Event.find({ action: "report.create", targetId: res.body.report._id }).lean();
    expect(ev.metadata?.format).toBe("csv");
  });
});

describe("invitations", () => {
  it("send, resend, revoke", async () => {
    const send = await as(request(app).post("/api/invitations").send({ email: "someone-new@test.com", role: "viewer" }));
    expect(send.status).toBe(201);
    const id = send.body.invitation._id;
    await as(request(app).post(`/api/invitations/${id}/resend`));
    await as(request(app).delete(`/api/invitations/${id}`));
    for (const action of ["invitation.send", "invitation.resend", "invitation.revoke"]) {
      const rows = await Event.find({ action, targetId: id }).lean();
      expect(rows.length).toBe(1);
      expect(rows[0].targetLabel).toBe("someone-new@test.com");
    }
  });

  it("accept records the joining member; an unauthenticated decline records the invitee's email", async () => {
    const token = (n: string) => crypto.createHash("sha1").update(n).digest("hex");
    const accept = await Invitation.create({ workspaceId: wsA._id, email: invitee.email, role: "editor", status: "pending", token: token("a"), expiresAt: new Date(Date.now() + 86400000), invitedBy: owner._id });
    const ok = await request(app).post(`/api/invitations/${accept.token}/accept`).set("Authorization", `Bearer ${tok(invitee)}`);
    expect(ok.status).toBe(200);
    const [a] = await Event.find({ action: "invitation.accept", targetId: accept._id.toString() }).lean();
    expect(a.actorEmail).toBe("ev-invitee@test.com");

    const decline = await Invitation.create({ workspaceId: wsA._id, email: "decliner@test.com", role: "viewer", status: "pending", token: token("d"), expiresAt: new Date(Date.now() + 86400000), invitedBy: owner._id });
    const res = await request(app).post(`/api/invitations/${decline.token}/decline`);
    expect(res.status).toBe(200);
    const [d] = await Event.find({ action: "invitation.decline", targetId: decline._id.toString() }).lean();
    expect(d.actorEmail).toBe("decliner@test.com");
    expect(d.actorId ?? null).toBeNull();
  });
});

describe("workspaces", () => {
  it("create, update, delete", async () => {
    const created = await request(app).post("/api/workspaces").set("Authorization", `Bearer ${tok(owner)}`).send({ name: "Audit WS", slug: "audit-ws" });
    expect(created.status).toBe(201);
    const ws = { _id: created.body.workspace._id };
    const id = ws._id;
    const call = (r: request.Test) => r.set("Authorization", `Bearer ${tok(owner)}`);
    await call(request(app).put(`/api/workspaces/${id}`).send({ name: "Audit WS 2" }));
    await call(request(app).delete(`/api/workspaces/${id}`));
    expect((await Event.find({ action: "workspace.create", targetId: id })).length).toBe(1);
    const [u] = await Event.find({ action: "workspace.update", targetId: id }).lean();
    expect(u.metadata?.fields).toEqual(["name"]);
    expect((await Event.find({ action: "workspace.delete", targetId: id })).length).toBe(1);
  });

  it("settings update and export", async () => {
    await as(request(app).patch("/api/workspaces/current").send({ name: "Events A renamed" }));
    const exp = await as(request(app).post("/api/workspaces/current/export"));
    expect(exp.status).toBe(202);
    expect((await eventsFor("workspace.update")).length).toBeGreaterThanOrEqual(1);
    const [ev] = await Event.find({ action: "workspace.export", targetId: exp.body.exportJob.id }).lean();
    expect(ev.workspaceId.toString()).toBe(wsA._id.toString());
  });
});

describe("audit trail must never break the action", () => {
  it("a failing event write does not fail the request", async () => {
    jest.spyOn(Event, "create").mockRejectedValue(new Error("db down"));
    jest.spyOn(console, "error").mockImplementation(() => {}); // the helper logs the failure it swallows
    const res = await as(request(app).post("/api/forms").send({ title: "Survives audit failure", fields: [{ label: "Q", type: "short_text", required: false }] }));
    expect(res.status).toBe(201);
  });
});
