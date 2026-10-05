import mongoose from "mongoose";
import dotenv from "dotenv";
import Form from "../models/Form";

// Sprint 13, BE 0.6 (D1.1). Gives every EXISTING form an explicit accessMode of "open" (Mode 1), which is what
// every form created before Sprint 13 already is. Reads already treat a missing value as "open", so this is
// belt and braces - it makes the stored data match the behaviour and means a later change of the default for
// new forms can never reach back and alter a live form.
//
// Idempotent: only forms with no accessMode are touched, so running it twice changes nothing the second
// time. `--dry-run` reports the count without writing. Rollback: unset `settings.accessMode` - readers
// default a missing value to "open", so that is safe and instantly equivalent.
//
//   npm run migrate:access-mode -- --dry-run
//   npm run migrate:access-mode
export const migrateAccessMode = async (options: { dryRun?: boolean } = {}): Promise<{ matched: number; modified: number }> => {
  // includeDeleted: forms sitting in Trash come back on restore and must not come back as a surprise.
  const filter = { $or: [{ "settings.accessMode": { $exists: false } }, { "settings.accessMode": null }] };
  const matched = await Form.countDocuments(filter).setOptions({ includeDeleted: true });
  if (options.dryRun || matched === 0) return { matched, modified: 0 };
  const result = await Form.updateMany(filter, { $set: { "settings.accessMode": "open" } });
  return { matched, modified: result.modifiedCount };
};

export const rollbackAccessMode = async (): Promise<number> => {
  const result = await Form.updateMany({ "settings.accessMode": "open" }, { $unset: { "settings.accessMode": 1 } });
  return result.modifiedCount;
};

if (require.main === module) {
  dotenv.config();
  const run = async () => {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
      console.error("Set MONGODB_URI (or MONGO_URI). Refusing to guess which database to change.");
      process.exit(1);
    }
    const dryRun = process.argv.includes("--dry-run");
    const rollback = process.argv.includes("--rollback");
    await mongoose.connect(mongoUri);
    if (rollback) {
      console.log(`Rolled back: unset accessMode on ${await rollbackAccessMode()} forms.`);
    } else {
      const { matched, modified } = await migrateAccessMode({ dryRun });
      console.log(dryRun ? `[dry run] ${matched} forms would get accessMode "open".` : `Set accessMode "open" on ${modified} of ${matched} forms.`);
    }
    await mongoose.disconnect();
  };
  run().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
