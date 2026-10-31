import "./_refuseProduction"; // must stay the first import: stops the script before anything else loads
import mongoose from "mongoose";
import dotenv from "dotenv";
import Template from "../models/Template";
import { fieldShowcaseTemplate } from "../utils/fieldShowcaseTemplate";

dotenv.config();

// Adds (or refreshes) ONLY the "Field Showcase" template. Unlike seedTemplates.ts it does not clear the
// other templates, so it is safe to run against a database that already has workspace templates.
const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding");
  await Template.deleteMany({ name: fieldShowcaseTemplate.name, workspaceId: null });
  await Template.create(fieldShowcaseTemplate);
  console.log(`Seeded "${fieldShowcaseTemplate.name}" (${fieldShowcaseTemplate.fields.length} fields)`);
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
