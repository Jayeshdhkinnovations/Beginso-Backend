import fs from "fs";
import path from "path";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import Template from "../models/Template";
import { builtInTemplates } from "../data/builtInTemplates";
import { planTemplateSync, syncTemplates } from "../services/templateSync.service";
import { describeSync, refusesProductionWrite, wantsApply } from "../scripts/syncTemplates";

process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";

let mongoServer: MongoMemoryServer;
const catalogue = builtInTemplates({ pages: [], fields: [] });
const FIXTURE = path.join(__dirname, "fixtures", "gallery_card_job_application.json");

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});
beforeEach(async () => {
  await Template.deleteMany({});
});

describe("the safe sync of built-in templates", () => {
  it("is a dry run by default: it plans every template as added and writes nothing", async () => {
    const result = await syncTemplates(catalogue, { apply: false });
    expect(result.applied).toBe(false);
    expect(result.added).toHaveLength(catalogue.length);
    expect(result.changed).toEqual([]);
    expect(await Template.countDocuments()).toBe(0);
    expect(describeSync(result)[0]).toMatch(/^Dry run \(nothing written\)/);
  });

  it("with --apply adds the catalogue, and a second run finds nothing to change and keeps every _id", async () => {
    const first = await syncTemplates(catalogue, { apply: true });
    expect(first.applied).toBe(true);
    expect(await Template.countDocuments()).toBe(catalogue.length);
    const ids = Object.fromEntries((await Template.find()).map((t) => [t.slug, String(t._id)]));

    const second = await syncTemplates(catalogue, { apply: true });
    expect(second.added).toEqual([]);
    expect(second.changed).toEqual([]);
    expect(second.deactivated).toEqual([]);
    expect(second.unchanged).toBe(catalogue.length);
    const again = Object.fromEntries((await Template.find()).map((t) => [t.slug, String(t._id)]));
    expect(again).toEqual(ids);
  });

  it("updates a template that changed in place (same _id) and says which part changed", async () => {
    await syncTemplates(catalogue, { apply: true });
    const before = await Template.findOne({ slug: "job-application" });
    const edited = catalogue.map((t) => (t.slug === "job-application" ? { ...t, description: "A new description.", tags: [...t.tags, "Remote"] } : t));

    const plan = await planTemplateSync(edited);
    expect(plan.changed).toEqual([{ slug: "job-application", fields: expect.arrayContaining(["description", "tags"]) }]);
    expect(plan.added).toEqual([]);

    await syncTemplates(edited, { apply: true });
    const after = await Template.findOne({ slug: "job-application" });
    expect(String(after!._id)).toBe(String(before!._id));
    expect(after!.description).toBe("A new description.");
    expect(after!.tags).toContain("Remote");
  });

  it("deactivates a template that left the catalogue instead of deleting it, and reactivates it when it returns", async () => {
    await syncTemplates(catalogue, { apply: true });
    const without = catalogue.filter((t) => t.slug !== "exit-interview");
    const result = await syncTemplates(without, { apply: true });
    expect(result.deactivated).toEqual(["exit-interview"]);
    const row = await Template.findOne({ slug: "exit-interview" });
    expect(row).not.toBeNull();
    expect(row!.isActive).toBe(false);

    const back = await syncTemplates(catalogue, { apply: true });
    expect(back.changed).toEqual([{ slug: "exit-interview", fields: ["isActive"] }]);
    expect((await Template.findOne({ slug: "exit-interview" }))!.isActive).toBe(true);
  });

  it("never touches a template a workspace published, and never overwrites one that uses a catalogue slug", async () => {
    const ws = new mongoose.Types.ObjectId();
    const own = await Template.create({ name: "Our own", slug: "our-own-abc123", category: "Mine", theme: "x", workspaceId: ws, fields: [{ label: "Q", type: "short_text", required: false }] });
    const clash = await Template.create({ name: "Clash", slug: "job-application", category: "Mine", theme: "x", workspaceId: ws, fields: [{ label: "Q", type: "short_text", required: false }] });

    const result = await syncTemplates(catalogue, { apply: true });
    expect(result.conflicts).toEqual(["job-application"]);
    expect(result.deactivated).not.toContain("our-own-abc123");
    expect((await Template.findById(own._id))!.isActive).toBe(true);
    const kept = await Template.findById(clash._id);
    expect(kept!.name).toBe("Clash");
    expect(await Template.countDocuments({ slug: "job-application" })).toBe(1);
  });

  it("refuses a production write without ALLOW_TEMPLATE_SYNC=true, but always allows a dry run", () => {
    expect(wantsApply(["--apply"])).toBe(true);
    expect(wantsApply([])).toBe(false);
    expect(refusesProductionWrite(true, { NODE_ENV: "production" } as any)).toBe(true);
    expect(refusesProductionWrite(true, { NODE_ENV: "production", ALLOW_TEMPLATE_SYNC: "true" } as any)).toBe(false);
    expect(refusesProductionWrite(true, { NODE_ENV: "production", ALLOW_TEMPLATE_SYNC: "yes" } as any)).toBe(true);
    expect(refusesProductionWrite(false, { NODE_ENV: "production" } as any)).toBe(false);
    expect(refusesProductionWrite(true, { NODE_ENV: "development" } as any)).toBe(false);
  });
});

describe("the public gallery", () => {
  beforeEach(async () => {
    await syncTemplates(catalogue, { apply: true });
  });

  const CARD_KEYS = ["slug", "name", "description", "category", "tags", "fieldCount", "estimatedMinutes", "featured", "sortOrder", "layout", "thumbnail"].sort();

  it("returns slim cards, featured first and then in the catalogue's order, without the hidden templates", async () => {
    const res = await request(app).get("/api/templates/gallery");
    expect(res.status).toBe(200);
    const cards = res.body.data as any[];
    for (const c of cards) expect(Object.keys(c).sort()).toEqual(CARD_KEYS);
    expect(cards.length).toBe(catalogue.filter((t) => t.showInGallery !== false).length);
    expect(cards.map((c) => c.slug)).not.toContain("master-comprehensive-template");
    expect(cards.map((c) => c.slug)).not.toContain("field-showcase-all-field-types");
    // the featured six come first
    expect(cards.slice(0, 6).every((c) => c.featured)).toBe(true);
    expect(cards.slice(6).some((c) => c.featured)).toBe(false);
    const rest = cards.slice(6).map((c) => c.sortOrder);
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
  });

  it("lists the groups with how many templates each holds", async () => {
    const res = await request(app).get("/api/templates/gallery");
    const total = (res.body.categories as any[]).reduce((n, c) => n + c.count, 0);
    expect(total).toBe(res.body.data.length);
    expect(res.body.categories.length).toBeGreaterThanOrEqual(10);
    for (const c of res.body.categories) expect(Object.keys(c).sort()).toEqual(["count", "name"]);
  });

  it("filters by a group, and an old category name still works", async () => {
    const group = await request(app).get("/api/templates/gallery").query({ category: "Healthcare" });
    expect(group.status).toBe(200);
    expect(group.body.data.length).toBeGreaterThan(0);
    expect(group.body.data.every((c: any) => c.category === "Healthcare")).toBe(true);
    // the old name "Medicine" is the group "Healthcare"
    const old = await request(app).get("/api/templates/gallery").query({ category: "Medicine" });
    expect(old.body.data.map((c: any) => c.slug).sort()).toEqual(group.body.data.map((c: any) => c.slug).sort());
    // the groups do not shrink while one is chosen
    expect(old.body.categories.length).toBeGreaterThanOrEqual(10);
  });

  it("filters by a tag and refuses a category that does not exist", async () => {
    const tagged = await request(app).get("/api/templates/gallery").query({ tag: "appointments" });
    expect(tagged.body.data.map((c: any) => c.slug)).toEqual(expect.arrayContaining(["appointment-booking", "schedule-a-viewing"]));
    const bad = await request(app).get("/api/templates/gallery").query({ category: "nonsense" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("UNKNOWN_CATEGORY");
  });

  it("returns one template in full by slug, or by id for an old link, and 404 for an unknown one", async () => {
    const bySlug = await request(app).get("/api/templates/public/job-application");
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.data.slug).toBe("job-application");
    expect(bySlug.body.data.fields.length).toBeGreaterThan(0);
    expect(bySlug.body.data.fieldCount).toBe(bySlug.body.data.fields.filter((f: any) => !f.deleted).length);
    const byId = await request(app).get(`/api/templates/public/${bySlug.body.data._id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.data.slug).toBe("job-application");
    expect((await request(app).get("/api/templates/public/does-not-exist")).status).toBe(404);
    // a template that is hidden from the gallery is not served either
    expect((await request(app).get("/api/templates/public/master-comprehensive-template")).status).toBe(404);
  });

  it("puts the same new fields, in the same order, on the full public list", async () => {
    const res = await request(app).get("/api/templates/public");
    const list = res.body.data as any[];
    expect(list.slice(0, 6).every((t) => t.featured)).toBe(true);
    const job = list.find((t) => t.slug === "job-application");
    expect(job).toEqual(expect.objectContaining({ tags: expect.any(Array), estimatedMinutes: expect.any(Number), fieldCount: expect.any(Number), layout: expect.any(String), sortOrder: expect.any(Number) }));
  });

  it("keeps the shape of a real gallery card (a fixture taken from this endpoint)", async () => {
    const res = await request(app).get("/api/templates/gallery");
    const card = (res.body.data as any[]).find((c) => c.slug === "job-application");
    if (process.env.UPDATE_FIXTURE === "1") {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, JSON.stringify(card, null, 2) + "\n");
    }
    expect(card).toEqual(JSON.parse(fs.readFileSync(FIXTURE, "utf8")));
  });
});
