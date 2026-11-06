// "Save my style": a form's look (layout and branding without any upload, logo or text) kept in the workspace, or in the personal space, to apply to other
// forms. Scope, permissions, the limit, and hostile input.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import FormStyle, { MAX_STYLES_PER_SCOPE } from "../models/FormStyle";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-form-styles";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";

let mongoServer: MongoMemoryServer;
let owner: any, editor: any, viewer: any, outsider: any;
let ws: any, other: any;

const token = (u: any) => `Bearer ${generateToken({ id: u._id.toString(), email: u.email, role: u.role })}`;
const inWs = (r: request.Test, u: any, w = ws) => r.set("Authorization", token(u)).set("x-workspace-id", w._id.toString());
const personal = (r: request.Test, u: any) => r.set("Authorization", token(u)).set("x-workspace-slug", "personal");

const STYLE = {
  name: "Ocean calm",
  layout: "steps",
  branding: {
    primaryColor: "#0F766E",
    fontFamily: "playfair_display",
    cardStyle: "elevated",
    backgroundStyle: "image",
    backgroundImageUrl: "/form-pictures/ocean-mist.jpg",
    theme: { v: 1, colors: { text: "#0F172A", card: "#FFFFFF" }, fields: { style: "filled" }, fonts: { heading: "fraunces" } },
  },
};

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const mk = (n: string) => User.create({ firebaseUid: `uid-style-${n}`, fullName: `Style ${n}`, email: `style-${n}@test.com`, status: "active" });
  owner = await mk("owner");
  editor = await mk("editor");
  viewer = await mk("viewer");
  outsider = await mk("outsider");
  ws = await Workspace.create({ name: "Styles WS", slug: "styles-ws", timezone: "UTC", owner: owner._id });
  other = await Workspace.create({ name: "Other WS", slug: "other-styles-ws", timezone: "UTC", owner: outsider._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  await Membership.create({ userId: editor._id, workspaceId: ws._id, role: "editor" });
  await Membership.create({ userId: viewer._id, workspaceId: ws._id, role: "viewer" });
  await Membership.create({ userId: outsider._id, workspaceId: other._id, role: "owner" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await FormStyle.deleteMany({});
});

describe("saving and listing", () => {
  it("saves a style and lists it for every member of the workspace", async () => {
    const created = await inWs(request(app).post("/api/form-styles").send(STYLE), editor);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: "Ocean calm", layout: "steps" });
    expect(created.body.data.branding).toEqual(STYLE.branding);

    for (const who of [owner, editor, viewer]) {
      const list = await inWs(request(app).get("/api/form-styles"), who);
      expect(list.status).toBe(200);
      expect(list.body.data.map((s: any) => s.name)).toEqual(["Ocean calm"]);
      expect(list.body.limit).toBe(MAX_STYLES_PER_SCOPE);
    }
  });

  it("keeps a workspace's styles away from another workspace and from the personal space", async () => {
    await inWs(request(app).post("/api/form-styles").send(STYLE), owner);
    expect((await inWs(request(app).get("/api/form-styles"), outsider, other)).body.data).toEqual([]);
    expect((await personal(request(app).get("/api/form-styles"), owner)).body.data).toEqual([]);
  });

  it("in the personal space a style is its creator's alone", async () => {
    expect((await personal(request(app).post("/api/form-styles").send(STYLE), owner)).status).toBe(201);
    expect((await personal(request(app).get("/api/form-styles"), owner)).body.data).toHaveLength(1);
    expect((await personal(request(app).get("/api/form-styles"), outsider)).body.data).toEqual([]);
    expect((await inWs(request(app).get("/api/form-styles"), owner)).body.data).toEqual([]);
  });

  it("refuses a viewer who tries to save, and a person who is not in the workspace", async () => {
    expect((await inWs(request(app).post("/api/form-styles").send(STYLE), viewer)).status).toBe(403);
    expect((await inWs(request(app).post("/api/form-styles").send(STYLE), outsider)).status).toBeGreaterThanOrEqual(403);
    expect(await FormStyle.countDocuments()).toBe(0);
  });

  it("needs a signed-in person", async () => {
    expect((await request(app).get("/api/form-styles")).status).toBe(401);
    expect((await request(app).post("/api/form-styles").send(STYLE)).status).toBe(401);
  });

  it("stops at the limit with a plain message, and a deleted style makes room", async () => {
    await FormStyle.insertMany(Array.from({ length: MAX_STYLES_PER_SCOPE }, (_, i) => ({ workspaceId: ws._id, createdBy: owner._id, name: `S${i}`, layout: "classic", branding: {} })));
    const refused = await inWs(request(app).post("/api/form-styles").send(STYLE), owner);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/up to 20/);
    const first = await FormStyle.findOne({});
    expect((await inWs(request(app).delete(`/api/form-styles/${first!._id}`), owner)).status).toBe(200);
    expect((await inWs(request(app).post("/api/form-styles").send(STYLE), owner)).status).toBe(201);
  });
});

describe("what a style keeps", () => {
  it("drops everything that belongs to one form: logo, icon, header text and links", async () => {
    const res = await inWs(
      request(app).post("/api/form-styles").send({ ...STYLE, branding: { ...STYLE.branding, logoUrl: "https://x.test/logo.png", iconName: "briefcase", iconColor: "#fff", bannerText: "Hello", bannerLinks: [{ url: "https://x.test" }], junk: 1 } }),
      owner,
    );
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.data.branding).sort()).toEqual(Object.keys(STYLE.branding).sort());
  });

  it("normalises a legacy layout name", async () => {
    const res = await inWs(request(app).post("/api/form-styles").send({ ...STYLE, layout: "single_column" }), owner);
    expect(res.status).toBe(201);
    expect(res.body.data.layout).toBe("classic");
  });

  it.each([
    ["an uploaded cover", { coverImageUrl: "/api/upload/file/u1/f1/brand/pic.png" }],
    ["an outside cover", { coverImageUrl: "https://x.test/a.png" }],
    ["an uploaded page background", { backgroundImageUrl: "/api/upload/file/u1/f1/brand/pic.png" }],
    ["a look-alike built-in path", { backgroundImageUrl: "/form-pictures/../x.jpg" }],
    ["a bad colour", { primaryColor: "red" }],
    ["an unknown font", { fontFamily: "comic_sans" }],
    ["a theme of another version", { theme: { v: 2 } }],
    ["a theme number out of range", { theme: { v: 1, card: { radius: 99 } } }],
  ])("refuses %s", async (_label, extra) => {
    expect((await inWs(request(app).post("/api/form-styles").send({ ...STYLE, branding: { ...STYLE.branding, ...extra } }), owner)).status).toBe(400);
  });

  it("accepts a built-in cover", async () => {
    const res = await inWs(request(app).post("/api/form-styles").send({ ...STYLE, branding: { ...STYLE.branding, coverImageUrl: "/form-pictures/calm-waves.jpg" } }), owner);
    expect(res.status).toBe(201);
  });
});

describe("a style is a look, not a form's own words", () => {
  it("keeps the button look and the progress style, and drops the button text and the note under the form", async () => {
    const theme = { v: 1, buttons: { size: "large", width: "auto", hover: "darken" }, progress: { style: "steps" }, labels: { submit: "Send it" }, footer: { note: "Thanks" }, card: { radius: 12 } };
    const res = await inWs(request(app).post("/api/form-styles").send({ ...STYLE, branding: { ...STYLE.branding, theme } }), owner);
    expect(res.status).toBe(201);
    expect(res.body.data.branding.theme).toEqual({ v: 1, buttons: theme.buttons, progress: theme.progress, card: theme.card });
    const onlyWords = await inWs(request(app).post("/api/form-styles").send({ ...STYLE, name: "Words", branding: { theme: { v: 1, labels: { next: "Go" }, footer: { note: "Hi" } } } }), owner);
    expect(onlyWords.status).toBe(201);
    expect(onlyWords.body.data.branding.theme).toBeUndefined();
  });
});

describe("a style keeps the look of the thank-you screen, not the form's own words", () => {
  it("keeps the accent colour and the confetti, and drops the headline, the picture and the redirect", async () => {
    const success = { headline: "You're in!", colour: "#16A34A", picture: "/form-pictures/aurora-mint.jpg", confetti: true, redirect: { url: "https://example.com" } };
    const res = await inWs(request(app).post("/api/form-styles").send({ ...STYLE, branding: { ...STYLE.branding, theme: { v: 1, card: { radius: 12 }, success } } }), owner);
    expect(res.status).toBe(201);
    expect(res.body.data.branding.theme).toEqual({ v: 1, card: { radius: 12 }, success: { colour: "#16A34A", confetti: true } });
    const onlyWords = await inWs(request(app).post("/api/form-styles").send({ ...STYLE, name: "Only words", branding: { theme: { v: 1, success: { headline: "Hi", redirect: { url: "https://example.com" } } } } }), owner);
    expect(onlyWords.status).toBe(201);
    expect(onlyWords.body.data.branding.theme).toBeUndefined();
  });
});

describe("a style keeps the background and the cover height", () => {
  it("they are looks, so they travel with a style", async () => {
    const theme = { v: 1, background: { from: "#1D4ED8", to: "#9333EA", angle: 45, darken: 35, blur: 8 }, cover: { height: 280 }, card: { radius: 12 } };
    const res = await inWs(request(app).post("/api/form-styles").send({ ...STYLE, branding: { ...STYLE.branding, theme } }), owner);
    expect(res.status).toBe(201);
    expect(res.body.data.branding.theme).toEqual(theme);
  });
});

describe("a style never keeps a remembered crop", () => {
  it("it belongs to one form's own pictures", async () => {
    const memo = { from: "/form-pictures/aurora-mint.jpg", result: "/api/upload/file/u1/f1/brand/c.jpg", aspect: 3.2, fx: 0.5, fy: 0.5, zoom: 1 };
    const res = await inWs(request(app).post("/api/form-styles").send({ ...STYLE, branding: { ...STYLE.branding, theme: { v: 1, card: { radius: 12 }, crop: { cover: memo } } } }), owner);
    expect(res.status).toBe(201);
    expect(res.body.data.branding.theme).toEqual({ v: 1, card: { radius: 12 } });
  });
});

describe("hostile input", () => {
  it.each([
    ["no name", { ...STYLE, name: undefined }],
    ["an empty name", { ...STYLE, name: "   " }],
    ["a long name", { ...STYLE, name: "x".repeat(61) }],
    ["a name that is not a string", { ...STYLE, name: { $gt: "" } }],
    ["a layout that does not exist", { ...STYLE, layout: "carousel" }],
    ["no layout", { ...STYLE, layout: undefined }],
    ["no branding", { ...STYLE, branding: undefined }],
    ["branding as a string", { ...STYLE, branding: "x" }],
    ["branding as a list", { ...STYLE, branding: [] }],
  ])("refuses %s", async (_label, body) => {
    expect((await inWs(request(app).post("/api/form-styles").send(body as object), owner)).status).toBe(400);
    expect(await FormStyle.countDocuments()).toBe(0);
  });

  it("does not let the body choose the workspace or the author", async () => {
    const res = await inWs(request(app).post("/api/form-styles").send({ ...STYLE, workspaceId: other._id.toString(), createdBy: outsider._id.toString() }), editor);
    expect(res.status).toBe(201);
    const stored = await FormStyle.findById(res.body.data._id);
    expect(String(stored!.workspaceId)).toBe(String(ws._id));
    expect(String(stored!.createdBy)).toBe(String(editor._id));
  });
});

describe("renaming and removing", () => {
  const save = async (who: any) => (await inWs(request(app).post("/api/form-styles").send(STYLE), who)).body.data._id as string;

  it("lets the person who saved it rename and remove it", async () => {
    const id = await save(editor);
    const renamed = await inWs(request(app).patch(`/api/form-styles/${id}`).send({ name: "Calmer" }), editor);
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe("Calmer");
    expect((await inWs(request(app).delete(`/api/form-styles/${id}`), editor)).status).toBe(200);
    expect(await FormStyle.countDocuments()).toBe(0);
  });

  it("lets an Owner remove an Editor's style, and refuses another Editor", async () => {
    const id = await save(editor);
    await Membership.create({ userId: (await User.create({ firebaseUid: "uid-style-editor2", fullName: "Editor Two", email: "style-editor2@test.com", status: "active" }))._id, workspaceId: ws._id, role: "editor" });
    const second = await User.findOne({ email: "style-editor2@test.com" });
    expect((await inWs(request(app).delete(`/api/form-styles/${id}`), second)).status).toBe(403);
    expect(await FormStyle.countDocuments()).toBe(1);
    expect((await inWs(request(app).delete(`/api/form-styles/${id}`), owner)).status).toBe(200);
  });

  it("refuses a viewer, and an id from another workspace is a plain 404", async () => {
    const id = await save(owner);
    expect((await inWs(request(app).delete(`/api/form-styles/${id}`), viewer)).status).toBe(403);
    expect((await inWs(request(app).delete(`/api/form-styles/${id}`), outsider, other)).status).toBe(404);
    expect((await inWs(request(app).patch(`/api/form-styles/${id}`).send({ name: "x" }), outsider, other)).status).toBe(404);
    expect(await FormStyle.countDocuments()).toBe(1);
  });

  it.each(["not-an-id", "123", "%7B%24gt%7D"])("answers 404 for the id %s", async (id) => {
    expect((await inWs(request(app).delete(`/api/form-styles/${id}`), owner)).status).toBe(404);
  });

  it("refuses a bad new name", async () => {
    const id = await save(owner);
    for (const name of ["", "  ", "x".repeat(61), 5, null]) expect((await inWs(request(app).patch(`/api/form-styles/${id}`).send({ name }), owner)).status).toBe(400);
  });
});
