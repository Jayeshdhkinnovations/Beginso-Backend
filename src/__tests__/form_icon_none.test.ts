import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import Form from "../models/Form";
import { createFormSchema } from "../validations/form.validator";
import { countFormIcons, applyFormIconMigration } from "../services/formIcon.service";
import { describeIconCounts } from "../scripts/reportFormIcons";
import { refusesProductionWrite, valueOf, wantsApply } from "../scripts/migrateFormIconsNone";
import { withIconChoice } from "../controllers/template.controller";

let mongo: MongoMemoryServer;
const owner = new mongoose.Types.ObjectId();
const workspace = new mongoose.Types.ObjectId();
const make = (title: string, branding: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
  Form.collection.insertOne({ title, owner, workspace, branding, createdAt: new Date("2026-10-15"), ...extra });

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await make("logo", { logoUrl: "https://x/logo.png", iconName: "star" });
  await make("icon-old", { iconName: "star" }, { createdAt: new Date("2026-09-01") });
  await make("icon-new", { iconName: "camera", iconColor: "#111" });
  await make("none", { iconNone: true });
  await make("never", {});
  await make("trashed", { iconName: "star" }, { deletedAt: new Date() });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("iconNone", () => {
  it("is accepted by the branding validator", () => {
    const r = createFormSchema.safeParse({ title: "Plain form", branding: { iconNone: true } });
    expect(r.success).toBe(true);
  });

  it("withIconChoice marks a form with no mark as deliberately without one, and leaves a mark alone", () => {
    expect(withIconChoice(undefined)).toEqual({ iconNone: true });
    expect(withIconChoice({ primaryColor: "#123456" })).toEqual({ primaryColor: "#123456", iconNone: true });
    expect(withIconChoice({ iconName: "star" })).toEqual({ iconName: "star" });
    expect(withIconChoice({ logoUrl: "https://x/l.png" })).toEqual({ logoUrl: "https://x/l.png" });
  });
});

describe("form icon report", () => {
  it("counts only, and sorts forms into the four groups", async () => {
    const c = await countFormIcons();
    expect(c).toMatchObject({ forms: 5, trashed: 1, withLogo: 1, withIcon: 2, iconNone: 1, neither: 1 });
    expect(c.iconByMonth).toEqual([{ month: "2026-09", count: 1 }, { month: "2026-10", count: 2 }]);
    const text = describeIconCounts(c).join("\n");
    expect(text).not.toMatch(/icon-old|logo\.png|trashed/);
  });
});

describe("form icon migration", () => {
  it("a dry run writes nothing", async () => {
    const r = await applyFormIconMigration({}, { apply: false });
    expect(r).toEqual({ wouldSwitch: 2, switched: 0, applied: false });
    expect(await Form.collection.countDocuments({ "branding.iconName": "star" })).toBe(3);
  });

  it("--apply with a date range switches only forms in range, never logos, Trash or chosen None", async () => {
    const r = await applyFormIconMigration({ createdAfter: "2026-10-01" }, { apply: true });
    expect(r.switched).toBe(1);
    const c = await countFormIcons();
    expect(c).toMatchObject({ withLogo: 1, withIcon: 1, iconNone: 2 });
    expect(await Form.collection.countDocuments({ title: "icon-new", "branding.iconColor": { $exists: true } })).toBe(0);
    expect(await Form.collection.countDocuments({ title: "trashed", "branding.iconName": "star" })).toBe(1);
  });

  it("rejects a day that is not a day", async () => {
    await expect(applyFormIconMigration({ createdAfter: "yesterday" }, { apply: false })).rejects.toThrow(/day/);
  });

  it("guards: production needs the allow flag; flags are read", () => {
    expect(refusesProductionWrite(true, { NODE_ENV: "production" })).toBe(true);
    expect(refusesProductionWrite(true, { NODE_ENV: "production", ALLOW_FORM_ICON_MIGRATION: "true" })).toBe(false);
    expect(refusesProductionWrite(false, { NODE_ENV: "production" })).toBe(false);
    expect(wantsApply(["--apply"])).toBe(true);
    expect(valueOf(["--created-after", "2026-10-01"], "--created-after")).toBe("2026-10-01");
  });
});
