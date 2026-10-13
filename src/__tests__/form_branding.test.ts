// Form branding choices: curated values only, image addresses restricted to safe http(s) or this API's own upload
// path (they end up in <img src> and CSS url(...)), and the public form read returns what the page needs to draw itself.
process.env.JWT_SECRET = "test-jwt-secret-key-for-form-branding";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;
let tOwner: string;
let slugWs: string;
let formId: string;

const headers = () => ({ Authorization: `Bearer ${tOwner}`, "x-workspace-slug": slugWs });
const patchBranding = (branding: Record<string, unknown>) => request(app).patch(`/api/forms/${formId}`).set(headers()).send({ branding });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const owner = await User.create({ firebaseUid: "uid-brand-owner", fullName: "Owner", email: "owner@brand.test", status: "active" });
  const ws = await Workspace.create({ name: "Brand Workspace", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  tOwner = generateToken({ id: owner._id.toString(), email: owner.email, role: "user" });
  slugWs = ws.slug;
  const created = await request(app).post("/api/forms").set(headers()).send({ title: "Brand form", fields: [{ label: "Name", type: "short_text", required: false }] });
  expect(created.status).toBe(201);
  formId = created.body.form._id;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("curated look choices", () => {
  it("accepts every documented value", async () => {
    const res = await patchBranding({
      primaryColor: "#1D4ED8", backgroundColor: "#fff", fontFamily: "lora", typeScale: "large", cardStyle: "elevated",
      panelTreatment: "gradient", fieldGrouping: "single", backgroundStyle: "mesh", formWidth: "wide", coverFit: "original",
      buttonStyle: "outline", buttonRadius: "16px", coverPosition: "top", spacing: "spacious", showProgress: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.branding ?? res.body.form?.branding).toMatchObject({ fontFamily: "lora", formWidth: "wide", coverFit: "original", backgroundStyle: "mesh" });
  });

  it.each([
    ["fontFamily", "comic_sans"], ["typeScale", "huge"], ["cardStyle", "glass"], ["panelTreatment", "video"], ["fieldGrouping", "triple"],
    ["backgroundStyle", "rainbow"], ["formWidth", "full"], ["coverFit", "stretch"], ["backgroundColor", "red"], ["primaryColor", "#12"],
  ])("rejects %s = %s", async (key, value) => {
    expect((await patchBranding({ [key]: value })).status).toBe(400);
  });
});

describe("image addresses", () => {
  it.each(["logoUrl", "coverImageUrl", "backgroundImageUrl"])("%s accepts an uploaded-file path, an http(s) address and an empty value", async (key) => {
    for (const value of ["/api/upload/file/u1/f1/brand/pic.png", "https://cdn.example.com/a.png", "http://localhost:5000/api/upload/file/u1/f1/brand/pic.png", ""]) {
      expect((await patchBranding({ [key]: value })).status).toBe(200);
    }
  });

  it.each(["logoUrl", "coverImageUrl", "backgroundImageUrl"])("%s rejects schemes and characters that could break out of url(...)", async (key) => {
    for (const value of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "ftp://example.com/a.png",
      "https://user:pass@example.com/a.png",
      'https://example.com/a.png")',
      "https://example.com/a b.png",
      "https://example.com/<script>",
      "//example.com/a.png",
      "relative/path.png",
      "https://example.com/" + "a".repeat(2100),
    ]) {
      expect((await patchBranding({ [key]: value })).status).toBe(400);
    }
  });
});

describe("public form read", () => {
  it("returns the new keys the page needs to draw itself", async () => {
    await patchBranding({ backgroundStyle: "image", backgroundImageUrl: "https://cdn.example.com/bg.jpg", formWidth: "narrow", coverFit: "banner", fontFamily: "inter" });
    const published = await request(app).post(`/api/forms/${formId}/publish`).set(headers());
    expect(published.status).toBe(200);
    const pub = await request(app).get(`/api/public/${published.body.slug}`);
    expect(pub.status).toBe(200);
    expect(pub.headers["cache-control"]).toMatch(/no-store/);
    const b = (pub.body.form ?? pub.body).branding;
    expect(b).toMatchObject({ backgroundStyle: "image", backgroundImageUrl: "https://cdn.example.com/bg.jpg", formWidth: "narrow", coverFit: "banner", fontFamily: "inter" });
  });
});
