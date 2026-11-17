import { CATEGORY_GROUPS, LEGACY_CATEGORY_MAP, galleryGroups, groupOfCategory } from "../utils/templateCatalog";

// A catalogue that has not been synced yet still carries the old category names (HR, Events, Lead Generation...). The gallery must group those under the
// current groups, not count only the few old names that happen to equal a current one (Education, Real Estate).
describe("the gallery groups for old category names", () => {
  it("puts every old category name under a current group", () => {
    for (const old of Object.keys(LEGACY_CATEGORY_MAP)) {
      expect(CATEGORY_GROUPS as readonly string[]).toContain(groupOfCategory(old));
    }
  });

  it("counts a catalogue stored with old names by their groups, so the counts add up to the total", () => {
    const stored = ["HR", "HR", "HR", "Events", "Events", "Education", "Real Estate", "Real Estate", "Real Estate", "Lead Generation", "E-commerce", "Feedback"];
    const groups = galleryGroups(stored);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(stored.length);
    expect(groups.length).toBeGreaterThan(4);
    expect(groups.find((g) => g.name === "Education")?.count).toBe(1);
    expect(groups.find((g) => g.name === "Real Estate")?.count).toBe(3);
  });

  it("lists the current groups in their order, drops empty ones, and keeps an unknown name as written after them", () => {
    const groups = galleryGroups(["Real Estate", "Education", "Something New", "Something New"]);
    const names = groups.map((g) => g.name);
    expect(names.indexOf("Education")).toBeLessThan(names.indexOf("Real Estate"));
    expect(names[names.length - 1]).toBe("Something New");
    expect(groups.find((g) => g.name === "Something New")?.count).toBe(2);
    expect(names).not.toContain("Bookings");
  });

  it("leaves a current group name and a blank value sensibly", () => {
    expect(groupOfCategory("Bookings")).toBe("Bookings");
    expect(groupOfCategory("bookings")).toBe("Bookings");
    expect(groupOfCategory(undefined)).toBe("");
    expect(galleryGroups([undefined, ""])).toEqual([]);
  });
});
