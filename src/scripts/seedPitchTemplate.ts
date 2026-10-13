import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import Template from "../models/Template";
import { refuseInProduction } from "./_guard";

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";

const seedPitchTemplate = async () => {
  refuseInProduction("replace the pitch template");
  try {
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB for seeding pitch template");

    const seedsPath = path.join(__dirname, "../../seeds.json");
    if (!fs.existsSync(seedsPath)) {
      console.error(`❌ seeds.json file not found at ${seedsPath}`);
      process.exit(1);
    }

    const rawData = fs.readFileSync(seedsPath, "utf-8");
    const seedsData = JSON.parse(rawData);

    const templateData = {
      name: "Pitch",
      category: "advanced",
      theme: "classic-light",
      isActive: true,
      pages: seedsData.pages || [],
      fields: seedsData.fields || [],
    };

    // Remove existing template with name 'pitch' if present to avoid duplication
    await Template.deleteMany({ name: /^pitch$/i, workspaceId: null }); // built-in only

    const createdTemplate = await Template.create(templateData);

    console.log("🎉 Successfully created 'pitch' template in templates section!");
    console.log(`📋 Template Name: ${createdTemplate.name}`);
    console.log(`🏷️ Category: ${createdTemplate.category}`);
    console.log(`📄 Pages: ${createdTemplate.pages?.length || 0}`);
    console.log(`📝 Fields: ${createdTemplate.fields.length}`);
    console.log(`🆔 ID: ${createdTemplate._id}`);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding pitch template:", error);
    process.exit(1);
  }
};

seedPitchTemplate();
