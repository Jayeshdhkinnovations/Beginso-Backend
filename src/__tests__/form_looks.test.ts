import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app";
import { brandingSchema, fieldSchema } from "../validations/form.validator";
import { FORM_FONTS, FORM_LAYOUT_VALUES } from "../models/Form";
import { FORM_LOOKS, FORM_LOOKS_VERSION, lookBranding, readabilityChecks } from "../utils/formLooks";
import { builtInTemplates } from "../data/builtInTemplates";

const catalogue = builtInTemplates({ pages: [], fields: [] });
const bySlug = new Map(catalogue.map((t) => [t.slug, t]));
const OLD = ["clean", "corporate", "editorial", "playful", "midnight", "sunset", "mint", "paper", "tech", "calm", "bold", "handwritten"];
const NEW_IDS = ["clean-corporate", "warm-friendly", "elegant-serif", "bold-event", "playful-bright", "calm-care", "minimal-paper", "dark-tech", "editorial-split", "appetite"];

describe("the Looks data file", () => {
  it("keeps the twelve Looks that already existed, and adds the ten families", () => {
    const ids = FORM_LOOKS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [...OLD, ...NEW_IDS]) expect(ids).toContain(id);
    expect(ids).toHaveLength(OLD.length + NEW_IDS.length);
  });

  it.each(FORM_LOOKS.map((l) => [l.id, l] as const))("%s is a branding the form validator accepts, with a real layout and fonts", (_id, look) => {
    const r = brandingSchema.safeParse(look.branding);
    expect(r.success ? "ok" : JSON.stringify(r.error.issues)).toBe("ok");
    // nothing is dropped as unknown: what is stored is what was written
    if (r.success) expect(r.data).toEqual(look.branding);
    expect(FORM_LAYOUT_VALUES).toContain(look.layout);
    expect(FORM_FONTS).toContain(look.branding.fontFamily);
    expect(look.name.length).toBeGreaterThan(0);
    expect(look.note.length).toBeGreaterThan(0);
    expect(look.goodFor.length).toBeGreaterThan(0);
  });

  it.each(FORM_LOOKS.map((l) => [l.id, l] as const))("%s is easy to read: text 4.5 to 1, field border and brand colour 3 to 1", (_id, look) => {
    const failing = readabilityChecks(look.branding)
      .filter((c) => c.ratio < c.need)
      .map((c) => `${c.id} ${c.ratio} < ${c.need}`);
    expect(failing).toEqual([]);
  });

  it("uses no gradient, mesh or pattern in the ten new families, and no icon mark anywhere", () => {
    for (const look of FORM_LOOKS.filter((l) => NEW_IDS.includes(l.id))) {
      expect(["gradient", "mesh", "dots", "grid"]).not.toContain(look.branding.backgroundStyle);
      expect(["gradient", "pattern"]).not.toContain(look.branding.panelTreatment);
    }
    for (const look of FORM_LOOKS) expect(JSON.stringify(look)).not.toMatch(/iconName|logoUrl/);
  });

  it("lookBranding returns a copy, so a template cannot change a Look", () => {
    const a = lookBranding("elegant-serif");
    a.branding.primaryColor = "#000000";
    expect(lookBranding("elegant-serif").branding.primaryColor).toBe("#7A5C3E");
  });
});

describe("GET /api/form-looks", () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    await mongoose.disconnect();
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it("is public, read-only and cached, and answers 304 to a client that already has this version", async () => {
    const res = await request(app).get("/api/form-looks");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(FORM_LOOKS.length);
    expect(res.body.version).toBe(FORM_LOOKS_VERSION);
    expect(res.headers["cache-control"]).toMatch(/public, max-age=300/);
    const again = await request(app).get("/api/form-looks").set("If-None-Match", res.headers.etag);
    expect(again.status).toBe(304);
    expect((await request(app).post("/api/form-looks").send({})).status).toBe(404);
  });
});

describe("every built-in template, as a form would be made from it", () => {
  it("has a branding the form validator accepts (the template model does not check it, so this does)", () => {
    for (const t of catalogue) {
      if (!t.branding) continue;
      const r = brandingSchema.safeParse(t.branding);
      expect(r.success ? "ok" : `${t.slug}: ${JSON.stringify(r.error.issues)}`).toBe("ok");
    }
  });

  it("has fields the form validator accepts, and a layout that exists", () => {
    for (const t of catalogue.filter((x) => x.slug !== "pitch-plan")) {
      for (const f of t.fields) {
        const r = fieldSchema.safeParse({ ...f, deleted: false });
        expect(r.success ? "ok" : `${t.slug} / ${f.label}: ${JSON.stringify(r.error.issues)}`).toBe("ok");
      }
      if (t.settings?.layout) expect([...FORM_LAYOUT_VALUES, "single_column", "two_column"]).toContain(t.settings.layout);
    }
  });
});

describe("the three rebuilt templates", () => {
  it.each([
    ["wedding-rsvp", "elegant-serif", "card_stack"],
    ["job-application", "clean-corporate", "steps"],
    ["waitlist", "dark-tech", "focus"],
  ])("%s wears the %s Look and its colours pass", (slug, lookId, layout) => {
    const t = bySlug.get(slug)!;
    const look = lookBranding(lookId);
    // a template keeps its own layout where the Look's default is not the right one (a job application is steps)
    expect(t.settings.layout).toBe(layout);
    expect(t.branding.primaryColor).toBe(look.branding.primaryColor);
    expect(t.branding.theme.colors).toEqual(look.branding.theme.colors);
    expect(readabilityChecks(t.branding).filter((c) => c.ratio < c.need)).toEqual([]);
    expect(t.branding.iconName).toBeUndefined();
    expect(t.branding.logoUrl).toBeUndefined();
  });

  it("Wedding RSVP asks 'Will you be there?' with the couple's own words, and the meal and guests only to those who accept", () => {
    const t = bySlug.get("wedding-rsvp")!;
    const attend = t.fields.find((f: any) => f.fieldId === "wedding-attend");
    expect(attend).toMatchObject({ type: "yes_no", yesLabel: "Joyfully accept", noLabel: "Regretfully decline" });
    expect(attend.logicRules.map((r: any) => r.targetFieldId).sort()).toEqual(["wedding-guests", "wedding-meal"]);
    expect(attend.logicRules.every((r: any) => r.action === "show" && r.condition.operator === "equals" && r.condition.value === "Yes")).toBe(true);
    expect(t.settings.layout).toBe("card_stack");
    expect(t.branding.theme.labels.submit).toBe("Send my reply");
  });

  it("Job Application is three steps, ending in 'Send application'", () => {
    const t = bySlug.get("job-application")!;
    expect(t.pages.map((p: any) => p.title)).toEqual(["About you", "Your work", "One last thing"]);
    expect(t.settings.layout).toBe("steps");
    expect(t.fields.every((f: any) => t.pages.some((p: any) => p.id === f.pageId))).toBe(true);
    expect(t.branding.theme.labels).toEqual({ next: "Next", back: "Back", submit: "Send application" });
    expect(t.fields.find((f: any) => f.type === "file_upload").allowedMimeTypes).toEqual(["application/pdf"]);
  });

  it("Waitlist is one email and two optional questions, one at a time", () => {
    const t = bySlug.get("waitlist")!;
    expect(t.settings.layout).toBe("focus");
    expect(t.fields.map((f: any) => [f.type, f.required])).toEqual([["email", true], ["multiple_choice", false], ["multiple_choice", false]]);
    expect(t.branding.theme.labels.submit).toBe("Join the waitlist");
    expect(t.category).toBe("Leads & Contact");
  });
});

describe("what the form validator keeps", () => {
  it("keeps the couple's own words on the Yes / No question (an unknown key would be dropped silently)", () => {
    const attend = bySlug.get("wedding-rsvp")!.fields.find((f: any) => f.fieldId === "wedding-attend");
    const r = fieldSchema.safeParse({ ...attend, deleted: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ yesLabel: "Joyfully accept", noLabel: "Regretfully decline" });
  });

  it("keeps every colour, font and setting of each rebuilt template's branding", () => {
    for (const slug of ["wedding-rsvp", "job-application", "waitlist"]) {
      const branding = bySlug.get(slug)!.branding;
      const r = brandingSchema.safeParse(branding);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual(branding);
    }
  });

  it("asks one question per row in the ten new families, and puts no icon or logo on any template", () => {
    for (const look of FORM_LOOKS.filter((l) => NEW_IDS.includes(l.id))) expect(look.branding.fieldGrouping).toBe("single");
    for (const slug of ["wedding-rsvp", "job-application", "waitlist"]) expect(bySlug.get(slug)!.branding.fieldGrouping).toBe("single");
  });
});
