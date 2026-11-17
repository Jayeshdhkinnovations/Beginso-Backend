import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import Template from "../models/Template";
import { builtInTemplates } from "../data/builtInTemplates";
import { refuseInProduction } from "./_guard";

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";

// For LOCAL development only: it deletes and re-inserts every built-in template, so their ids change. Production uses `npm run sync:templates`.
const seedTemplates = async () => {
  refuseInProduction("replace the built-in templates");
  try {
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB for seeding");

    // Read seeds.json for pitch template
    let pitchSeedsData: any = { pages: [], fields: [] };
    const seedsPath = path.join(__dirname, "../../seeds.json");
    if (fs.existsSync(seedsPath)) {
      pitchSeedsData = JSON.parse(fs.readFileSync(seedsPath, "utf-8"));
    }

    // Clear the BUILT-IN templates only (workspaceId null). Templates a workspace published (workspaceId set) are never touched.
    const removed = await Template.deleteMany({ workspaceId: null });
    console.log(`🗑️ Cleared ${removed.deletedCount} built-in templates (workspace templates are kept)`);

    const templates = builtInTemplates(pitchSeedsData);

    const inserted = await Template.insertMany(templates);
    console.log(`✅ Successfully seeded ${inserted.length} templates!`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding templates:", error);
    process.exit(1);
  }
};

seedTemplates();
