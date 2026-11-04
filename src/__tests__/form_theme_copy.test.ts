// branding.theme (the owner's colours, fields look and exact sizes) travels with the form: a duplicate, a form made from a workspace template, and a
// form moved between spaces all keep it, and none of them shares it with the original.
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

process.env.JWT_SECRET = "test-jwt-secret-key-for-form-theme-copy";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";

let mongoServer: MongoMemoryServer;
let owner: any;
let ws: any;
let ws2: any;

const THEME = {
  v: 1,
  colors: { text: "#111827", heading: "#7C3AED", card: "#FFF7ED", field: "#FFFFFF", fieldBorder: "#6B7280", buttonText: "#FFFFFF" },
  fields: { style: "filled", radius: 12, label: "start", choice: "tiles" },
  card: { radius: 28, shadow: 70 },
  layout: { maxWidth: 760, fieldGap: 22 },
};

const auth = () => `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role })}`;
const inWs = (r: request.Test, w = ws) => r.set("Authorization", auth()).set("x-workspace-id", w._id.toString());

const withTheme = () =>
  Form.create({
    title: "Themed form",
    workspaceId: ws._id,
    createdBy: owner._id,
    status: "draft",
    slug: `themed-${Math.random().toString(36).slice(2, 8)}`,
    pages: [{ id: "page-a", order: 0, title: "About you" }],
    fields: [{ fieldId: "f1", pageId: "page-a", label: "Name", type: "short_text", required: true }],
    branding: { primaryColor: "#DC2626", theme: THEME as any },
  });

const themeOf = async (id: string) => ((await Form.findById(id).lean()) as any)?.branding?.theme;
const themeInBody = (body: any) => (body.data ?? body.form ?? body).branding?.theme;

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  owner = await User.create({ firebaseUid: "uid-theme-owner", fullName: "Theme Owner", email: "theme-owner@test.com", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "Theme WS", slug: "theme-ws", timezone: "UTC", owner: owner._id });
  ws2 = await Workspace.create({ name: "Theme WS Two", slug: "theme-ws-two", timezone: "UTC", owner: owner._id });
  owner.workspaceId = ws._id;
  await owner.save();
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  await Membership.create({ userId: owner._id, workspaceId: ws2._id, role: "owner" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("branding.theme is copied", () => {
  it("by duplicate, as a copy that shares nothing with the original", async () => {
    const original = await withTheme();
    const res = await inWs(request(app).post(`/api/forms/${original._id}/duplicate`));
    expect(res.status).toBe(201);
    const copyId = (res.body.data ?? res.body.form ?? res.body)._id;
    expect(await themeOf(copyId)).toEqual(THEME);
    await Form.updateOne({ _id: copyId }, { $set: { "branding.theme.card.radius": 4 } });
    expect((await themeOf(String(original._id))).card.radius).toBe(28);
  });

  it("by use template (a workspace template made from a themed form)", async () => {
    const source = await withTheme();
    const published = await inWs(request(app).post("/api/templates").send({ formId: String(source._id), name: "Themed template" }));
    expect(published.status).toBe(201);
    const templateId = (published.body.data ?? published.body.template ?? published.body)._id;
    const used = await inWs(request(app).post(`/api/templates/${templateId}/use`).send({ destinationWorkspaceId: String(ws._id) }));
    expect(used.status).toBe(201);
    const formId = used.body.data._id;
    expect(themeInBody(used.body)).toEqual(THEME);
    expect(await themeOf(formId)).toEqual(THEME);
  });

  it("by use template into another workspace of the same owner", async () => {
    const source = await withTheme();
    const published = await inWs(request(app).post("/api/templates").send({ formId: String(source._id), name: "Themed template 2" }));
    const templateId = (published.body.data ?? published.body.template ?? published.body)._id;
    const used = await inWs(request(app).post(`/api/templates/${templateId}/use`).send({ destinationWorkspaceId: String(ws2._id) }));
    expect(used.status).toBe(201);
    expect(await themeOf(used.body.data._id)).toEqual(THEME);
  });

  it("when the form is moved between spaces (workspace to workspace, then to personal)", async () => {
    const form = await withTheme();
    const toWs2 = await inWs(request(app).post(`/api/forms/${form._id}/move`).send({ targetWorkspaceId: String(ws2._id) }));
    expect(toWs2.status).toBe(200);
    expect(String(((await Form.findById(form._id).lean()) as any).workspaceId)).toBe(String(ws2._id));
    expect(await themeOf(String(form._id))).toEqual(THEME);

    const toPersonal = await inWs(request(app).post(`/api/forms/${form._id}/move`).send({ targetWorkspaceId: "personal" }), ws2);
    expect(toPersonal.status).toBe(200);
    expect(((await Form.findById(form._id).lean()) as any).workspaceId).toBeNull();
    expect(await themeOf(String(form._id))).toEqual(THEME);
  });

  it("a form with no theme stays without one through all three", async () => {
    const plain = await Form.create({ title: "Plain", workspaceId: ws._id, createdBy: owner._id, status: "draft", slug: `plain-${Math.random().toString(36).slice(2, 8)}`, fields: [{ fieldId: "f1", label: "A", type: "short_text", required: false }] });
    const copy = await inWs(request(app).post(`/api/forms/${plain._id}/duplicate`));
    expect(await themeOf((copy.body.data ?? copy.body.form ?? copy.body)._id)).toBeUndefined();
    await inWs(request(app).post(`/api/forms/${plain._id}/move`).send({ targetWorkspaceId: String(ws2._id) }));
    expect(await themeOf(String(plain._id))).toBeUndefined();
  });
});
