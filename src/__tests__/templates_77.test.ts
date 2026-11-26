import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import Template from "../models/Template";
import { builtInTemplates } from "../data/builtInTemplates";
import { REPLACES, seedTemplates, showIfProblems } from "../data/seedTemplates";
import { brandingSchema, fieldSchema } from "../validations/form.validator";
import { FORM_LAYOUT_VALUES } from "../models/Form";
import { readabilityChecks } from "../utils/formLooks";
import { CATEGORY_GROUPS } from "../utils/templateCatalog";
import { findTemplateByKey } from "../utils/templateLookup";
import { planTemplateSync, syncTemplates } from "../services/templateSync.service";
import { waveOf } from "../scripts/syncTemplates";

// The 77 templates of the seed (waves 1, 2 and 3) as the catalogue holds them. No database except in the sync tests at the end (an in-memory one).
const catalogue = builtInTemplates({ pages: [], fields: [] });
const fresh = catalogue.filter((t: any) => typeof t.wave === "number");
const older = catalogue.filter((t: any) => typeof t.wave !== "number");
const bySlug = new Map(catalogue.map((t: any) => [t.slug, t]));

describe("the 77 templates: shape", () => {
  it("are 77 in three waves of 25, 30 and 22, with unique slugs and names", () => {
    expect(seedTemplates).toHaveLength(77);
    expect(fresh).toHaveLength(77);
    for (const [wave, n] of [[1, 25], [2, 30], [3, 22]]) expect(fresh.filter((t: any) => t.wave === wave)).toHaveLength(n);
    expect(new Set(fresh.map((t: any) => t.slug)).size).toBe(77);
    expect(new Set(fresh.map((t: any) => t.name)).size).toBe(77);
  });

  it("belong to the thirteen groups, and use a layout that exists", () => {
    expect(CATEGORY_GROUPS).toHaveLength(13);
    for (const t of fresh) {
      expect(CATEGORY_GROUPS as readonly string[]).toContain(t.category);
      expect([...FORM_LAYOUT_VALUES, "single_column", "two_column"]).toContain(t.settings.layout);
    }
  });

  it("keep every field on a page that exists, and every page has a field", () => {
    for (const t of fresh) {
      const pages = new Set(t.pages.map((p: any) => p.id));
      expect(t.fields.every((f: any) => pages.has(f.pageId))).toBe(true);
      expect(t.pages.every((p: any) => t.fields.some((f: any) => f.pageId === p.id))).toBe(true);
    }
  });

  it("have a stable, unique id on every field", () => {
    for (const t of fresh) {
      const ids = t.fields.map((f: any) => f.fieldId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id: unknown) => typeof id === "string" && (id as string).startsWith(`${t.slug}-`))).toBe(true);
    }
  });
});

describe("the 77 templates: the real schemas (the template model checks neither, so this does)", () => {
  it("have a branding the form validator accepts, with nothing dropped", () => {
    const failing: string[] = [];
    for (const t of fresh) {
      const r = brandingSchema.safeParse(t.branding);
      if (!r.success) failing.push(`${t.slug}: ${JSON.stringify(r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`))}`);
      else if (JSON.stringify(sorted(r.data)) !== JSON.stringify(sorted(t.branding))) failing.push(`${t.slug}: the validator changed or dropped something`);
    }
    expect(failing).toEqual([]);
  });

  it("have fields the form validator accepts", () => {
    const failing: string[] = [];
    for (const t of fresh) {
      for (const f of t.fields) {
        const r = fieldSchema.safeParse({ ...f, deleted: false });
        if (!r.success) failing.push(`${t.slug} / ${f.label}: ${JSON.stringify(r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`))}`);
      }
    }
    expect(failing).toEqual([]);
  });

  it("keep every Yes / No word and nothing the validator does not know (no _showIf is left over)", () => {
    for (const t of fresh) {
      for (const f of t.fields) expect(f).not.toHaveProperty("_showIf");
    }
    const attend = bySlug.get("wedding-rsvp")!.fields.find((f: any) => f.type === "yes_no");
    expect(attend).toMatchObject({ yesLabel: "Joyfully accept", noLabel: "Regretfully decline" });
  });
});

describe("the 77 templates: show-if", () => {
  it("maps every _showIf to a real rule: no problem is reported", () => {
    expect(showIfProblems).toEqual([]);
  });

  it("puts the rule on the deciding question, as an equals rule, with the stored answer (Yes / No, not yes / no)", () => {
    const rules = fresh.flatMap((t: any) => t.fields.flatMap((f: any) => (f.logicRules ?? []).map((r: any) => ({ slug: t.slug, source: f, rule: r, template: t }))));
    expect(rules).toHaveLength(7);
    for (const { source, rule, template } of rules) {
      expect(rule.action).toBe("show");
      expect(rule.condition).toMatchObject({ fieldId: source.fieldId, operator: "equals" });
      expect(template.fields.some((f: any) => f.fieldId === rule.targetFieldId)).toBe(true);
      if (source.type === "yes_no") expect(["Yes", "No"]).toContain(rule.condition.value);
      else expect(source.options).toContain(rule.condition.value);
    }
    const waiver = bySlug.get("liability-waiver")!;
    const under18 = waiver.fields.find((f: any) => f.label === "Is the participant under 18?");
    expect(under18.logicRules.map((r: any) => waiver.fields.find((f: any) => f.fieldId === r.targetFieldId).label).sort()).toEqual(["Guardian name", "Guardian signature"]);
    expect(under18.logicRules.every((r: any) => r.condition.value === "Yes")).toBe(true);
  });
});

describe("the 77 templates: colours", () => {
  it("pass the contrast checks on their own final pairs (text 4.5 to 1, field border and brand colour 3 to 1)", () => {
    const failing: string[] = [];
    for (const t of fresh) {
      for (const c of readabilityChecks(t.branding)) if (c.ratio < c.need) failing.push(`${t.slug}: ${c.id} ${c.ratio} < ${c.need}`);
    }
    expect(failing).toEqual([]);
  });

  it("set no icon, logo, gradient or photo", () => {
    for (const t of fresh) {
      expect(t.branding.iconName).toBeUndefined();
      expect(t.branding.logoUrl).toBeUndefined();
      expect(t.branding.coverImageUrl).toBeUndefined();
      expect(["gradient", "mesh"]).not.toContain(t.branding.backgroundStyle);
      expect(["gradient"]).not.toContain(t.branding.panelTreatment);
    }
  });
});

describe("renamed templates", () => {
  it("name old slugs that exist in the older catalogue, and none of them is itself one of the 77", () => {
    const olderSlugs = new Set(older.map((t: any) => t.slug));
    const freshSlugs = new Set(fresh.map((t: any) => t.slug));
    expect(Object.keys(REPLACES)).toHaveLength(13);
    for (const [slug, olds] of Object.entries(REPLACES)) {
      expect(freshSlugs.has(slug)).toBe(true);
      for (const old of olds) {
        expect(olderSlugs.has(old)).toBe(true);
        expect(freshSlugs.has(old)).toBe(false);
      }
    }
  });

  it("an old slug finds the template that replaced it, and says where it came from", () => {
    const list = fresh.map((t: any) => ({ _id: `id-${t.slug}`, slug: t.slug, replaces: t.replaces }));
    expect(findTemplateByKey(list, "general-contact-form")).toMatchObject({ found: { slug: "contact-us" }, redirectedFrom: "general-contact-form" });
    expect(findTemplateByKey(list, "contact-us")).toMatchObject({ found: { slug: "contact-us" } });
    expect(findTemplateByKey(list, "contact-us").redirectedFrom).toBeUndefined();
    expect(findTemplateByKey(list, "id-waitlist")).toMatchObject({ found: { slug: "waitlist" } });
    expect(findTemplateByKey(list, "never-existed")).toEqual({});
  });
});

describe("--wave", () => {
  it("reads 1, 2 or 3, nothing when absent, and refuses anything else", () => {
    expect(waveOf([])).toEqual({});
    expect(waveOf(["--wave", "2"])).toEqual({ wave: 2 });
    for (const bad of ["0", "4", "x", ""]) expect(waveOf(["--wave", bad]).error).toMatch(/1, 2 or 3/);
    expect(waveOf(["--wave"]).error).toMatch(/1, 2 or 3/);
  });
});

describe("the sync by wave (an in-memory database)", () => {
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

  it("starts from the older catalogue as it is today, and a plain sync does not touch any wave", async () => {
    const base = await syncTemplates(catalogue, { apply: true });
    expect(base.added.length).toBe(older.length);
    expect(await Template.countDocuments({ wave: { $exists: true } })).toBe(0);
    const again = await planTemplateSync(catalogue);
    expect(again.added).toEqual([]);
    expect(again.changed).toEqual([]);
    expect(again.deactivated).toEqual([]);
  });

  it("a dry run of wave 1 writes nothing and lists wave 1 only, with the older templates it would switch off", async () => {
    const before = await Template.countDocuments({});
    const plan = await syncTemplates(catalogue, { apply: false, wave: 1 });
    expect(plan.applied).toBe(false);
    expect(await Template.countDocuments({})).toBe(before);
    const wave1 = fresh.filter((t: any) => t.wave === 1).map((t: any) => t.slug);
    expect([...plan.added, ...plan.changed.map((c) => c.slug)].sort()).toEqual([...wave1].sort());
    const wave1Replaces = fresh.filter((t: any) => t.wave === 1).flatMap((t: any) => t.replaces);
    expect([...plan.deactivated].sort()).toEqual([...wave1Replaces].sort());
  });

  it("wave 1 adds its templates, keeps the id of one that already existed, switches the replaced ones off and deletes nothing", async () => {
    const jobBefore = await Template.findOne({ slug: "job-application" });
    const total = await Template.countDocuments({});
    const result = await syncTemplates(catalogue, { apply: true, wave: 1 });
    expect(result.applied).toBe(true);
    const jobAfter = await Template.findOne({ slug: "job-application" });
    if (jobBefore) expect(String(jobAfter!._id)).toBe(String(jobBefore._id));
    expect(jobAfter!.wave).toBe(1);
    expect(await Template.countDocuments({})).toBe(total + result.added.length); // nothing deleted
    for (const old of fresh.filter((t: any) => t.wave === 1).flatMap((t: any) => t.replaces)) {
      const row = await Template.findOne({ slug: old });
      expect(row).not.toBeNull();
      expect(row!.isActive).toBe(false);
    }
    // waves 2 and 3 are not in the database
    expect(await Template.countDocuments({ wave: { $in: [2, 3] } })).toBe(0);
  });

  it("a later plain sync does not switch the replaced templates back on, and wave 1 again changes nothing", async () => {
    await syncTemplates(catalogue, { apply: true });
    const old = await Template.findOne({ slug: "general-contact-form" });
    expect(old!.isActive).toBe(false);
    const again = await planTemplateSync(catalogue, 1);
    expect([...again.added, ...again.changed, ...again.deactivated]).toEqual([]);
  });

  it("a wave that has not been synced stays out of the database, and a wave 2 sync touches only wave 2 and what it replaces", async () => {
    const wave1Rows = await Template.countDocuments({ wave: 1 });
    await syncTemplates(catalogue, { apply: true, wave: 2 });
    expect(await Template.countDocuments({ wave: 1 })).toBe(wave1Rows);
    expect(await Template.countDocuments({ wave: 2 })).toBe(30);
    expect(await Template.countDocuments({ wave: 3 })).toBe(0);
  });
});

function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}
