import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User";
import "../models/Form";
import "../models/Response";
import "../models/Upload";
import { reconcileUser, ReconcileResult } from "../services/storage.service";

// Recomputes every user's true storage (forms + responses + uploads, Trash included) and corrects the
// running counter `User.storageUsedBytes` where it has drifted. Every mismatch is logged. Safe to re-run.
//   npm run reconcile:storage             fix drift
//   npm run reconcile:storage -- --dry-run  report only
export const reconcileAllStorage = async (dryRun = false): Promise<ReconcileResult[]> => {
  const out: ReconcileResult[] = [];
  for (const u of await User.find().select("_id").lean()) out.push(await reconcileUser(u._id, { dryRun }));
  return out;
};

if (require.main === module) {
  dotenv.config();
  const run = async () => {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
      console.error("Set MONGODB_URI (or MONGO_URI). Refusing to guess which database to change.");
      process.exit(1);
    }
    await mongoose.connect(mongoUri);
    const dryRun = process.argv.includes("--dry-run");
    const results = await reconcileAllStorage(dryRun);
    const drifted = results.filter((r) => r.drift !== 0);
    console.log(`Checked ${results.length} user(s); ${drifted.length} drifted${dryRun ? " (dry run, nothing changed)" : ", corrected"}.`);
    await mongoose.disconnect();
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
