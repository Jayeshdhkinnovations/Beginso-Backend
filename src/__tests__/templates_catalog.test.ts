import { builtInTemplates, rawBuiltInTemplates } from "../data/builtInTemplates";
import { applyCatalogMeta, CATALOG_META, CATEGORY_GROUPS, LEGACY_CATEGORY_MAP, SAMPLE_NOTE, SENSITIVE_SLUGS, estimateMinutes, libraryPicture, resolveCategoryGroup } from "../utils/templateCatalog";

// The built-in catalogue as data: its groups, tags, order, notes, pictures, layouts and show-if rules. No database.
const catalogue = builtInTemplates({ pages: [], fields: [] });
const bySlug = new Map(catalogue.map((t) => [t.slug, t]));
const gallery = catalogue.filter((t) => t.showInGallery !== false);

describe("the built-in catalogue: groups and tags", () => {
  it("has unique slugs", () => {
    const slugs = catalogue.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("puts every template in one of the twelve groups, and uses at least ten of them", () => {
    expect(CATEGORY_GROUPS).toHaveLength(12);
    for (const t of catalogue) expect(CATEGORY_GROUPS as readonly string[]).toContain(t.category);
    const used = new Set(gallery.map((t) => t.category));
    expect(used.size).toBeGreaterThanOrEqual(10);
  });

  it("maps every category name the catalogue used before onto a group, so an old link still works", () => {
    for (const t of rawBuiltInTemplates({ pages: [], fields: [] })) {
      expect(resolveCategoryGroup(t.category)).toBeDefined();
    }
    for (const [old, group] of Object.entries(LEGACY_CATEGORY_MAP)) {
      expect(resolveCategoryGroup(old)).toBe(group);
      expect(resolveCategoryGroup(old.toUpperCase())).toBe(group);
    }
    expect(resolveCategoryGroup("Healthcare")).toBe("Healthcare");
    expect(resolveCategoryGroup("nonsense")).toBeUndefined();
    expect(resolveCategoryGroup(42)).toBeUndefined();
  });

  it("gives no used group fewer than two gallery templates, and lets one template carry several tags", () => {
    for (const group of CATEGORY_GROUPS) {
      const n = gallery.filter((t) => t.category === group).length;
      if (n > 0) expect(n).toBeGreaterThanOrEqual(2);
    }
    expect(bySlug.get("schedule-a-viewing")!.tags).toEqual(expect.arrayContaining(["Real Estate", "Appointments"]));
    for (const t of catalogue) for (const tag of t.tags) expect(typeof tag === "string" && tag.trim().length > 0).toBe(true);
  });

  it("features six templates, and gives every template its own sort order and a time to fill", () => {
    expect(gallery.filter((t) => t.featured)).toHaveLength(6);
    const catalogued = catalogue.filter((t) => CATALOG_META[t.slug]);
    const orders = catalogued.map((t) => t.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
    for (const t of catalogue) expect(t.estimatedMinutes).toBeGreaterThanOrEqual(1);
    for (const slug of Object.keys(CATALOG_META)) expect(bySlug.has(slug)).toBe(true);
  });

  it("estimates the time from what is asked: a paragraph takes longer than a tick", () => {
    expect(estimateMinutes([])).toBe(1);
    expect(estimateMinutes([{ type: "yes_no" }, { type: "yes_no" }])).toBe(1);
    expect(estimateMinutes([{ type: "long_text" }, { type: "long_text" }, { type: "file_upload" }])).toBe(3);
    expect(estimateMinutes([{ type: "long_text", deleted: true }])).toBe(1);
  });
});

describe("the built-in catalogue: content", () => {
  it("has no photo from Unsplash left: none has a credit we know, so each was swapped for one of our own pictures", () => {
    expect(JSON.stringify(catalogue)).not.toContain("images.unsplash.com");
    for (const t of catalogue) {
      for (const key of ["coverImageUrl", "backgroundImageUrl"]) {
        const url = t.branding?.[key];
        if (url) expect(url).toMatch(/^\/form-pictures\/[a-z0-9-]{1,40}\.jpg$/);
      }
    }
    expect(libraryPicture("Bookings", "x")).toMatch(/^\/form-pictures\/(ocean-mist|calm-waves)\.jpg$/);
  });

  it("keeps a photo that carries its credit", () => {
    const credited = {
      slug: "x",
      branding: { coverImageUrl: "https://images.unsplash.com/photo-1?w=1", theme: { v: 1, credit: { cover: { name: "A. Person", url: "https://unsplash.com/@a" } } } },
      fields: [],
    };
    expect(applyCatalogMeta(credited).branding.coverImageUrl).toBe("https://images.unsplash.com/photo-1?w=1");
  });

  it("uses the Compact layout only for internal forms, not for the four customer-facing ones", () => {
    const compact = gallery.filter((t) => t.settings?.layout === "compact").map((t) => t.slug).sort();
    expect(compact).toEqual(["equipment-request", "property-inspection-report", "timesheet-submission"]);
    for (const slug of ["appointment-booking", "appointment-request", "schedule-a-viewing", "club-membership-renewal"]) {
      expect(bySlug.get(slug)!.settings.layout).toBe("classic");
    }
  });

  it("asks Net Promoter Score on the real 0 to 10 scale", () => {
    const nps = bySlug.get("net-promoter-score")!;
    const q = nps.fields[0];
    expect(q.type).toBe("number");
    expect([q.min, q.max]).toEqual([0, 10]);
    expect(q.helpText).toMatch(/0 is not at all likely, 10 is extremely likely/);
    expect(JSON.stringify(nps)).not.toMatch(/1 is not at all likely, 5/);
  });

  it("adds the sample note once to each template that asks for sensitive details, and claims no compliance", () => {
    for (const slug of SENSITIVE_SLUGS) {
      const d = bySlug.get(slug)!.description as string;
      expect(d.split(SAMPLE_NOTE).length - 1).toBe(1);
    }
    expect(bySlug.get("job-application")!.description).not.toContain(SAMPLE_NOTE);
    expect(JSON.stringify(catalogue)).not.toMatch(/HIPAA|GDPR compliant|compliant with/i);
  });

  it("does not name one country's paperwork where a neutral word does the same job", () => {
    expect(JSON.stringify(catalogue)).not.toMatch(/W-9|EIN or VAT|#MLS-/);
  });

  it("gives every field a stable id that is unique inside its template, and show-if rules that point at fields that exist", () => {
    for (const t of catalogue) {
      const ids = t.fields.map((f: any) => f.fieldId);
      expect(ids.every((id: unknown) => typeof id === "string" && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      for (const f of t.fields) {
        for (const rule of f.logicRules ?? []) {
          expect(ids).toContain(rule.targetFieldId);
          expect(ids).toContain(rule.condition.fieldId);
        }
      }
    }
  });

  it("asks the 'only if' questions only when they apply", () => {
    const rulesOf = (slug: string) => {
      const t = bySlug.get(slug)!;
      return t.fields.flatMap((f: any) =>
        (f.logicRules ?? []).map((r: any) => ({ source: f.label, target: t.fields.find((x: any) => x.fieldId === r.targetFieldId).label, when: r.condition.value, action: r.action })),
      );
    };
    expect(rulesOf("food-delivery-order")).toEqual([{ source: "Delivery Time", target: "Scheduled Time", when: "Schedule for later", action: "show" }]);
    expect(rulesOf("wedding-rsvp").map((r: any) => r.target).sort()).toEqual(["Meal Choice", "Number of Guests"]);
    expect(rulesOf("wedding-rsvp").every((r: any) => r.when === "Yes" && r.source === "Will you attend?")).toBe(true);
  });

  it("gives the two RSVPs a thank-you screen with confetti", () => {
    for (const slug of ["party-rsvp", "wedding-rsvp"]) expect(bySlug.get(slug)!.branding.theme.success.confetti).toBe(true);
  });

  it("keeps the master template and the field showcase out of the public gallery", () => {
    expect(bySlug.get("master-comprehensive-template")!.showInGallery).toBe(false);
    expect(bySlug.get("field-showcase-all-field-types")!.showInGallery).toBe(false);
  });
});
