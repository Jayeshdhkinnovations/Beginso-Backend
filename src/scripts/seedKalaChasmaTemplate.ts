import mongoose from "mongoose";
import dotenv from "dotenv";
import Template from "../models/Template";
import { refuseInProduction } from "./_guard";
import { kalaChasmaTemplate } from "../data/kalaChasmaTemplate";

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";

const seedKalaChasmaTemplate = async () => {
  refuseInProduction("replace the Kala Chasma template");
  try {
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");

    await Template.deleteMany({ name: /^Kala Chasma Content Acquisition$/i, workspaceId: null });

    const created = await Template.create(kalaChasmaTemplate as any);

    console.log("🎉 Seeded Kala Chasma Content Acquisition template");
    console.log(`📋 Name: ${created.name}`);
    console.log(`🏷️ Category: ${created.category}`);
    console.log(`📄 Pages: ${created.pages?.length ?? 0}`);
    console.log(`📝 Fields: ${created.fields.length}`);
    console.log(`🆔 ID: ${created._id}`);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding Kala Chasma template:", error);
    process.exit(1);
  }
};

seedKalaChasmaTemplate();
