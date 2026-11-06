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

// the branding as the reply carries it: at the top, or inside the form
const brandingOf = (body: any) => body.branding ?? body.form?.branding;

describe("curated look choices", () => {
  it("accepts every documented value", async () => {
    const res = await patchBranding({
      primaryColor: "#1D4ED8", backgroundColor: "#fff", fontFamily: "lora", typeScale: "large", cardStyle: "elevated",
      panelTreatment: "gradient", fieldGrouping: "single", backgroundStyle: "mesh", formWidth: "wide", coverFit: "original", logoSize: "lg",
      buttonStyle: "outline", buttonRadius: "16px", coverPosition: "top", spacing: "spacious", showProgress: false,
    });
    expect(res.status).toBe(200);
    expect(brandingOf(res.body)).toMatchObject({ fontFamily: "lora", formWidth: "wide", coverFit: "original", logoSize: "lg", backgroundStyle: "mesh" });
  });

  it.each([
    ["fontFamily", "comic_sans"], ["typeScale", "huge"], ["cardStyle", "glass"], ["panelTreatment", "video"], ["fieldGrouping", "triple"],
    ["backgroundStyle", "rainbow"], ["formWidth", "full"], ["coverFit", "stretch"], ["logoSize", "huge"], ["backgroundColor", "red"], ["primaryColor", "#12"],
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

describe("header text and links", () => {
  it("accepts a line of text and http(s) links, and the public form returns them", async () => {
    const bannerLinks = [{ label: "Privacy", url: "https://example.com/privacy" }, { url: "http://example.org" }];
    const res = await patchBranding({ bannerText: "Takes two minutes", bannerLinks });
    expect(res.status).toBe(200);
    const published = await request(app).post(`/api/forms/${formId}/publish`).set(headers());
    const pub = await request(app).get(`/api/public/${published.body.slug}`);
    expect((pub.body.form ?? pub.body).branding).toMatchObject({ bannerText: "Takes two minutes", bannerLinks });
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "ftp://example.com", "https://user:pw@example.com", "https://a.com/\"x", "not a url", ""])("rejects the link %j", async (url) => {
    expect((await patchBranding({ bannerLinks: [{ url }] })).status).toBe(400);
  });

  it("rejects more than five links", async () => {
    expect((await patchBranding({ bannerLinks: Array.from({ length: 6 }, () => ({ url: "https://example.com" })) })).status).toBe(400);
  });

  it("rejects text that is too long", async () => {
    expect((await patchBranding({ bannerText: "x".repeat(501) })).status).toBe(400);
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

describe("form icon (used when there is no uploaded logo)", () => {
  it("accepts an icon name and colour", async () => {
    const res = await patchBranding({ iconName: "shopping-cart", iconColor: "#16A34A" });
    expect(res.status).toBe(200);
    expect(brandingOf(res.body)).toMatchObject({ iconName: "shopping-cart", iconColor: "#16A34A" });
  });

  it.each([
    ["iconName", "Shopping Cart"], ["iconName", "x"], ["iconName", "<svg onload=alert(1)>"], ["iconName", "a".repeat(41)],
    ["iconColor", "green"], ["iconColor", "#12"], ["iconColor", "url(javascript:1)"],
  ])("rejects %s = %s", async (key, value) => {
    expect((await patchBranding({ [key]: value })).status).toBe(400);
  });

  it("the public form read returns the icon", async () => {
    await patchBranding({ iconName: "briefcase", iconColor: "#7C3AED" });
    const published = await request(app).post(`/api/forms/${formId}/publish`).set(headers());
    const pub = await request(app).get(`/api/public/${published.body.slug ?? published.body.publishedSlug}`);
    expect((pub.body.form ?? pub.body).branding).toMatchObject({ iconName: "briefcase", iconColor: "#7C3AED" });
  });
});

describe("branding.theme (colours, fields look, exact values)", () => {
  const theme = {
    v: 1,
    colors: { text: "#111827", heading: "#7C3AED", card: "#FFFFFF", field: "#F3F4F6", fieldBorder: "#9CA3AF", buttonText: "#fff" },
    fields: { style: "underline", radius: 12, label: "start", choice: "tiles" },
    card: { radius: 24, shadow: 60 },
    layout: { maxWidth: 900, fieldGap: 20 },
  };

  it("accepts every key and the public form read returns the theme", async () => {
    expect((await patchBranding({ theme })).status).toBe(200);
    const published = await request(app).post(`/api/forms/${formId}/publish`).set(headers());
    const pub = await request(app).get(`/api/public/${published.body.slug}`);
    expect((pub.body.form ?? pub.body).branding.theme).toEqual(theme);
  });

  it("accepts the bounds exactly", async () => {
    const res = await patchBranding({ theme: { v: 1, fields: { radius: 0 }, card: { radius: 40, shadow: 0 }, layout: { maxWidth: 360, fieldGap: 64 } } });
    expect(res.status).toBe(200);
    expect((await patchBranding({ theme: { v: 1, card: { shadow: 100 }, layout: { maxWidth: 1400, fieldGap: 4 }, fields: { radius: 32 } } })).status).toBe(200);
  });

  it("drops keys it does not know instead of storing them", async () => {
    const res = await patchBranding({ theme: { v: 1, evil: "x", colors: { text: "#000", sparkle: "#fff" }, card: { radius: 8, glow: 3 } } });
    expect(res.status).toBe(200);
    const stored = brandingOf(res.body).theme;
    expect(stored).toEqual({ v: 1, colors: { text: "#000" }, card: { radius: 8 } });
  });

  it.each([
    ["colors", { text: "red" }], ["colors", { heading: "#12" }], ["colors", { card: "url(javascript:1)" }], ["colors", { field: "#GGGGGG" }],
    ["colors", { fieldBorder: "" }], ["colors", { buttonText: "rgb(0,0,0)" }], ["colors", { text: "#" + "0".repeat(5000) }], ["colors", { text: 123 }],
    ["fields", { style: "glass" }], ["fields", { label: "inside" }], ["fields", { choice: "cards" }], ["fields", { radius: 33 }], ["fields", { radius: -1 }], ["fields", { radius: "12px" }],
    ["card", { radius: 41 }], ["card", { radius: 3.5 }], ["card", { shadow: 101 }], ["card", { shadow: "60" }],
    ["layout", { maxWidth: 359 }], ["layout", { maxWidth: 1401 }], ["layout", { fieldGap: 3 }], ["layout", { fieldGap: 65 }], ["layout", { maxWidth: null }],
  ])("rejects theme.%s = %j", async (group, value) => {
    expect((await patchBranding({ theme: { v: 1, [group as string]: value } })).status).toBe(400);
  });

  it.each([[{}], [{ v: 2 }], [{ v: "1" }], [{ v: 0 }], ["theme"], [["v"]], [7], [{ v: 1, colors: "red" }], [{ v: 1, fields: [] }]])("rejects the whole theme %j", async (value) => {
    expect((await patchBranding({ theme: value })).status).toBe(400);
  });

  it("rejects an oversized body", async () => {
    const res = await patchBranding({ theme: { v: 1, junk: "x".repeat(2_000_000) } });
    expect([400, 413]).toContain(res.status);
  });

  it("an older client that sends no theme leaves the stored theme alone, and a form that never had one reads without it", async () => {
    await patchBranding({ theme });
    expect((await patchBranding({ primaryColor: "#16A34A" })).status).toBe(200);
    const got = await request(app).get(`/api/forms/${formId}`).set(headers());
    expect(brandingOf(got.body).theme).toEqual(theme);
    // a client that knows the field clears it with null
    expect((await patchBranding({ theme: null })).status).toBe(200);
    const cleared = await request(app).get(`/api/forms/${formId}`).set(headers());
    expect(brandingOf(cleared.body).theme).toBeUndefined();
    const other = await request(app).post("/api/forms").set(headers()).send({ title: "Plain", fields: [{ label: "A", type: "short_text", required: false }] });
    const plain = await request(app).get(`/api/forms/${other.body.form._id}`).set(headers());
    expect(brandingOf(plain.body)?.theme).toBeUndefined();
  });
});

describe("built-in pictures (the app's own library)", () => {
  it.each(["logoUrl", "coverImageUrl", "backgroundImageUrl"])("%s accepts a built-in picture path", async (key) => {
    const res = await patchBranding({ [key]: "/form-pictures/aurora-mint.jpg" });
    expect(res.status).toBe(200);
  });

  it.each(["coverImageUrl", "backgroundImageUrl"])("%s keeps the built-in path on the public form read", async (key) => {
    await patchBranding({ [key]: "/form-pictures/calm-waves.jpg" });
    const published = await request(app).post(`/api/forms/${formId}/publish`).set(headers());
    const pub = await request(app).get(`/api/public/${published.body.slug}`);
    expect((pub.body.form ?? pub.body).branding[key]).toBe("/form-pictures/calm-waves.jpg");
  });

  it.each([
    "/form-pictures/../secret.jpg", "/form-pictures/a/b.jpg", "/form-pictures/UPPER.jpg", "/form-pictures/x.png", "/form-pictures/.jpg", "/form-pictures/",
    "/form-pictures/" + "a".repeat(41) + ".jpg", "form-pictures/x.jpg", "//form-pictures/x.jpg", "/form-pictures/x.jpg?a=b", "/form-pictures/x.jpg#f", "/form-pictures/x y.jpg",
    "/other/x.jpg", "/form-pictures/%2e%2e/x.jpg",
  ])("rejects %s", async (value) => {
    expect((await patchBranding({ coverImageUrl: value })).status).toBe(400);
  });
});

describe("more typefaces and a heading font", () => {
  const NEW_FONTS = ["poppins", "manrope", "plus_jakarta_sans", "outfit", "space_grotesk", "montserrat", "playfair_display", "merriweather", "source_serif_4", "fraunces", "dm_serif_display", "quicksand", "fredoka", "caveat", "pacifico", "bebas_neue", "space_mono"];

  it.each(NEW_FONTS)("fontFamily accepts %s", async (font) => {
    expect((await patchBranding({ fontFamily: font })).status).toBe(200);
  });

  it("the original five still work", async () => {
    for (const font of ["dm_sans", "inter", "work_sans", "lora", "nunito"]) expect((await patchBranding({ fontFamily: font })).status).toBe(200);
  });

  it("theme.fonts.heading is stored and returned by the public form read", async () => {
    expect((await patchBranding({ theme: { v: 1, fonts: { heading: "playfair_display" } } })).status).toBe(200);
    const published = await request(app).post(`/api/forms/${formId}/publish`).set(headers());
    const pub = await request(app).get(`/api/public/${published.body.slug}`);
    expect((pub.body.form ?? pub.body).branding.theme).toEqual({ v: 1, fonts: { heading: "playfair_display" } });
  });

  it.each([["comic_sans"], ["Playfair Display"], ["playfair_display; x"], [""], [7], [null]])("theme.fonts.heading rejects %j", async (value) => {
    expect((await patchBranding({ theme: { v: 1, fonts: { heading: value } } })).status).toBe(400);
  });

  it("drops a key in theme.fonts it does not know, and rejects fonts that is not an object", async () => {
    const res = await patchBranding({ theme: { v: 1, fonts: { heading: "caveat", weight: 900 } } });
    expect(res.status).toBe(200);
    expect(brandingOf(res.body).theme.fonts).toEqual({ heading: "caveat" });
    expect((await patchBranding({ theme: { v: 1, fonts: "caveat" } })).status).toBe(400);
  });
});

describe("new layouts and the Split Feature picture side", () => {
  it.each(["chat", "sidebar", "open", "focus"])("accepts the %s layout and the public read returns it unchanged", async (layout) => {
    const res = await request(app).patch(`/api/forms/${formId}`).set(headers()).send({ settings: { layout } });
    expect(res.status).toBe(200);
    const published = await request(app).post(`/api/forms/${formId}/publish`).set(headers());
    const pub = await request(app).get(`/api/public/${published.body.slug}`);
    expect((pub.body.form ?? pub.body).settings.layout).toBe(layout);
  });

  it("still refuses a layout that does not exist", async () => {
    expect((await request(app).patch(`/api/forms/${formId}`).set(headers()).send({ settings: { layout: "carousel" } })).status).toBe(400);
  });

  it.each(["start", "end"])("theme.layout.panelSide accepts %s and the public read returns it", async (side) => {
    expect((await patchBranding({ theme: { v: 1, layout: { panelSide: side } } })).status).toBe(200);
    const published = await request(app).post(`/api/forms/${formId}/publish`).set(headers());
    const pub = await request(app).get(`/api/public/${published.body.slug}`);
    expect((pub.body.form ?? pub.body).branding.theme.layout.panelSide).toBe(side);
  });

  it.each([["left"], ["right"], ["both"], [""], [1], [null]])("theme.layout.panelSide rejects %j", async (value) => {
    expect((await patchBranding({ theme: { v: 1, layout: { panelSide: value } } })).status).toBe(400);
  });
});

describe("buttons and details (theme.buttons, labels, progress, footer)", () => {
  const WHOLE = {
    v: 1,
    buttons: { size: "large", width: "auto", hover: "lift" },
    labels: { submit: "Send it", next: "Continue", back: "Go back" },
    progress: { style: "dots" },
    footer: { note: "Questions? Write to hello@example.com" },
  };

  it("stores all of it and returns it on the public form read", async () => {
    expect((await patchBranding({ theme: WHOLE })).status).toBe(200);
    const published = await request(app).post(`/api/forms/${formId}/publish`).set(headers());
    const pub = await request(app).get(`/api/public/${published.body.slug}`);
    expect((pub.body.form ?? pub.body).branding.theme).toEqual(WHOLE);
  });

  it.each([
    ["buttons.size", { buttons: { size: "huge" } }],
    ["buttons.width", { buttons: { width: "half" } }],
    ["buttons.hover", { buttons: { hover: "spin" } }],
    ["progress.style", { progress: { style: "wheel" } }],
    ["a button text over 30 characters", { labels: { submit: "x".repeat(31) } }],
    ["an empty button text", { labels: { next: "" } }],
    ["a button text with markup", { labels: { back: "<b>Back</b>" } }],
    ["a button text with a control character", { labels: { submit: "Send\u0007" } }],
    ["a footer note over 200 characters", { footer: { note: "x".repeat(201) } }],
    ["a footer note with markup", { footer: { note: "<script>alert(1)</script>" } }],
    ["labels as a string", { labels: "Send" }],
    ["a number as a button text", { labels: { submit: 5 } }],
  ])("refuses %s", async (_name, group) => {
    expect((await patchBranding({ theme: { v: 1, ...group } })).status).toBe(400);
  });

  it("trims the text and drops keys it does not know", async () => {
    const res = await patchBranding({ theme: { v: 1, labels: { submit: "  Send  ", shout: "HEY" }, footer: { note: " Hi ", size: 9 } } });
    expect(res.status).toBe(200);
    expect(brandingOf(res.body).theme.labels).toEqual({ submit: "Send" });
    expect(brandingOf(res.body).theme.footer).toEqual({ note: "Hi" });
  });

  it("keeps the whole thing when the form is patched by an older client that sends no theme", async () => {
    expect((await patchBranding({ theme: WHOLE })).status).toBe(200);
    expect((await patchBranding({ primaryColor: "#112233" })).status).toBe(200);
    const got = await request(app).get(`/api/forms/${formId}`).set(headers());
    expect(brandingOf(got.body).theme).toEqual(WHOLE);
  });
});

describe("the thank-you screen (theme.success)", () => {
  const WHOLE = {
    v: 1,
    success: {
      headline: "You're in!",
      colour: "#16A34A",
      picture: "/form-pictures/aurora-mint.jpg",
      confetti: true,
      redirect: { url: "https://example.com/welcome?from=form", seconds: 8 },
    },
  };

  it("stores all of it and returns it on the public form read", async () => {
    expect((await patchBranding({ theme: WHOLE })).status).toBe(200);
    const published = await request(app).post(`/api/forms/${formId}/publish`).set(headers());
    const pub = await request(app).get(`/api/public/${published.body.slug}`);
    expect((pub.body.form ?? pub.body).branding.theme).toEqual(WHOLE);
  });

  it.each([
    ["a headline over 60 characters", { headline: "x".repeat(61) }],
    ["a headline with markup", { headline: "<b>Hi</b>" }],
    ["an empty headline", { headline: "" }],
    ["a colour that is not a hex", { colour: "green" }],
    ["a picture with a bad scheme", { picture: "javascript:alert(1)" }],
    ["confetti that is not a boolean", { confetti: "yes" }],
    ["a redirect over http", { redirect: { url: "http://example.com" } }],
    ["a redirect to javascript:", { redirect: { url: "javascript:alert(1)" } }],
    ["a redirect with credentials", { redirect: { url: "https://user:pass@example.com" } }],
    ["a redirect with a space", { redirect: { url: "https://example.com/a b" } }],
    ["a redirect with a quote", { redirect: { url: "https://example.com/\"onload=1" } }],
    ["a redirect to a bare host name", { redirect: { url: "https://localhost" } }],
    ["a redirect over 500 characters", { redirect: { url: `https://example.com/${"a".repeat(500)}` } }],
    ["a redirect with no address", { redirect: { seconds: 5 } }],
    ["redirect seconds under 3", { redirect: { url: "https://example.com", seconds: 2 } }],
    ["redirect seconds over 30", { redirect: { url: "https://example.com", seconds: 31 } }],
    ["redirect seconds that are not whole", { redirect: { url: "https://example.com", seconds: 4.5 } }],
    ["success as a string", "yes"],
  ])("refuses %s", async (_name, success) => {
    expect((await patchBranding({ theme: { v: 1, success } })).status).toBe(400);
  });

  it("accepts a redirect with no seconds, trims the headline, and drops keys it does not know", async () => {
    const res = await patchBranding({ theme: { v: 1, success: { headline: "  Done  ", redirect: { url: "https://example.com", track: 1 }, shout: 1 } } });
    expect(res.status).toBe(200);
    expect(brandingOf(res.body).theme.success).toEqual({ headline: "Done", redirect: { url: "https://example.com" } });
  });

  it("keeps it when the form is patched by an older client that sends no theme", async () => {
    expect((await patchBranding({ theme: WHOLE })).status).toBe(200);
    expect((await patchBranding({ primaryColor: "#112233" })).status).toBe(200);
    const got = await request(app).get(`/api/forms/${formId}`).set(headers());
    expect(brandingOf(got.body).theme).toEqual(WHOLE);
  });
});
