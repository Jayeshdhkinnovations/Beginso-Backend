import mongoose from "mongoose";
import dotenv from "dotenv";
import SavedChart from "../models/SavedChart";

// Charts v2: Sprint 14 charts (formId, fieldId, chartType, groupBy, createdBy, order) become per-form per-user
// charts. Existing rows keep what viewers already saw: owner = createdBy, visibility = 'workspace', size 'medium',
// default options, granularity from groupBy, position = order. The API reads un-migrated rows the same way
// (chart.controller `normalise`), so running this is optional for correctness - it just writes the values down.
// Idempotent (only rows with no ownerId are touched) and reversible: touched rows carry `_v2m: true`, and
// --rollback unsets exactly the fields it added from exactly those rows (rows created natively in v2 are left alone).
//
//   npm run migrate:charts-v2 -- --dry-run     count what would change, write nothing
//   npm run migrate:charts-v2                  migrate + build the new index
//   npm run migrate:charts-v2 -- --rollback    undo the migrated rows and drop the index
const ADDED = ["ownerId", "visibility", "size", "options", "granularity", "position", "_v2m"];
const INDEX = "formId_1_ownerId_1";

export const migrateChartsV2 = async (options: { dryRun?: boolean } = {}) => {
  const todo = await SavedChart.collection.find({ ownerId: { $exists: false } }).toArray();
  if (!options.dryRun && todo.length) {
    await SavedChart.collection.bulkWrite(
      todo.map((c: any) => ({
        updateOne: {
          filter: { _id: c._id, ownerId: { $exists: false } },
          update: {
            $set: {
              ownerId: c.createdBy ?? null,
              visibility: "workspace",
              size: "medium",
              options: { valueMode: "count", legend: true, sort: "order" },
              granularity: c.groupBy === "week" ? "week" : c.groupBy === "day" ? "day" : null,
              position: c.order ?? 0,
              _v2m: true,
            },
          },
        },
      }))
    );
  }
  if (!options.dryRun) await SavedChart.createIndexes();
  return { total: await SavedChart.collection.countDocuments({}), migrated: options.dryRun ? 0 : todo.length, wouldMigrate: options.dryRun ? todo.length : 0 };
};

export const rollbackChartsV2 = async () => {
  const res = await SavedChart.collection.updateMany({ _v2m: true }, { $unset: Object.fromEntries(ADDED.map((f) => [f, ""])) });
  let indexDropped = false;
  try {
    await SavedChart.collection.dropIndex(INDEX);
    indexDropped = true;
  } catch {
    // already gone
  }
  return { rolledBack: res.modifiedCount, indexDropped };
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
    if (process.argv.includes("--rollback")) console.log("Rolled back:", await rollbackChartsV2());
    else console.log(await migrateChartsV2({ dryRun: process.argv.includes("--dry-run") }));
    await mongoose.disconnect();
  };
  run().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
