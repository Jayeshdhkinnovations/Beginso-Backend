import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import Template from "../models/Template";
import { planReactivation, reactivateTemplates, replacedSlugs } from "../services/templateReactivate.service";
import { describeReactivation, refusesProductionWrite, slugsOf, wantsApply } from "../scripts/reactivateTemplates";

let mongo: MongoMemoryServer;
const owner = new mongoose.Types.ObjectId();
const workspace = new mongoose.Types.ObjectId();
const row = (slug: string, over: Record<string, unknown> = {}) => Template.create({ name: slug, slug, category: "Leads & Contact", theme: "classic-light", fields: [], isActive: true, workspaceId: null, ...over });

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Template.deleteMany({});
  await row("general-contact-form", { isActive: false });
  await row("contact-sales", { isActive: false });
  await row("donation-form", { isActive: true }); // already on
  await row("contact-us"); // a new template: not in the replaced list
  await row("net-promoter-score", { isActive: false, workspaceId: workspace, createdBy: owner }); // a workspace template with a catalogue slug: never touched
});

describe("replacedSlugs", () => {
  it("are the 13 older templates that new ones replace", () => {
    const slugs = replacedSlugs();
    expect(slugs).toHaveLength(13);
    expect(slugs).toEqual(expect.arrayContaining(["general-contact-form", "contact-sales", "product-waitlist", "net-promoter-score", "vendor-registration"]));
    expect(slugs).not.toContain("contact-us");
  });
});

describe("reactivating templates", () => {
  it("plans: what is off would be switched on, what is on is left, what is missing is said", async () => {
    const plan = await planReactivation();
    expect(plan.toSwitchOn.sort()).toEqual(["contact-sales", "general-contact-form"]);
    expect(plan.alreadyOn).toEqual(["donation-form"]);
    expect(plan.missing).toContain("product-waitlist");
    // the workspace template with a catalogue slug is not a built-in template: it is reported missing, never switched on
    expect(plan.toSwitchOn).not.toContain("net-promoter-score");
    expect(plan.missing).toContain("net-promoter-score");
  });

  it("a dry run writes nothing", async () => {
    const r = await reactivateTemplates(undefined, { apply: false });
    expect(r.applied).toBe(false);
    expect(r.switchedOn).toBe(0);
    expect(await Template.countDocuments({ isActive: false })).toBe(3);
  });

  it("--apply switches on the built-in ones that were off, changes only isActive, deletes nothing, and leaves the workspace template alone", async () => {
    const before = await Template.countDocuments({});
    const r = await reactivateTemplates(undefined, { apply: true });
    expect(r.switchedOn).toBe(2);
    expect(await Template.countDocuments({})).toBe(before);
    expect((await Template.findOne({ slug: "general-contact-form" }))!.isActive).toBe(true);
    expect((await Template.findOne({ slug: "contact-sales" }))!.isActive).toBe(true);
    const ws = await Template.findOne({ slug: "net-promoter-score" });
    expect(ws!.isActive).toBe(false);
    // a second run has nothing to do
    expect((await reactivateTemplates(undefined, { apply: true })).switchedOn).toBe(0);
  });

  it("with --slugs only those slugs are looked at", async () => {
    const r = await reactivateTemplates(["contact-sales"], { apply: true });
    expect(r.switchedOn).toBe(1);
    expect((await Template.findOne({ slug: "general-contact-form" }))!.isActive).toBe(false);
  });
});

describe("the script", () => {
  it("reads --apply and --slugs, and refuses a production write without the flag", () => {
    expect(wantsApply(["--apply"])).toBe(true);
    expect(wantsApply([])).toBe(false);
    expect(slugsOf(["--slugs", "a, b ,c"])).toEqual(["a", "b", "c"]);
    expect(slugsOf([])).toBeUndefined();
    expect(slugsOf(["--slugs"])).toEqual([]);
    expect(refusesProductionWrite(true, { NODE_ENV: "production" })).toBe(true);
    expect(refusesProductionWrite(true, { NODE_ENV: "production", ALLOW_TEMPLATE_SYNC: "true" })).toBe(false);
    expect(refusesProductionWrite(false, { NODE_ENV: "production" })).toBe(false);
  });

  it("describes a dry run and an applied run", () => {
    const plan = { toSwitchOn: ["a"], alreadyOn: [], missing: ["b"], applied: false, switchedOn: 0 };
    expect(describeReactivation(plan)[0]).toMatch(/^Dry run/);
    expect(describeReactivation({ ...plan, applied: true, switchedOn: 1 })[0]).toBe("Applied:");
    expect(describeReactivation(plan).join("\n")).toContain("not found    1");
  });
});
