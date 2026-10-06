import mongoose from "mongoose";
import dotenv from "dotenv";
import Form from "../models/Form";
import Notification from "../models/Notification";
import SavedChart from "../models/SavedChart";
import { MailLog } from "../models/MailLog";

// Sprint 14 (BE 0.11 / 0.12). The whole Sprint 14 data change is ADDITIVE, so this script has no data to rewrite:
//   - Form.templateId / templateCategory      new nullable fields; absent reads as null; no backfill (OQ-4)
//   - Form counters                           none stored (completionRate is computed from viewsCount + a grouped count)
//   - SavedChart                              new collection
//   - Notification.workspaceId                required -> optional in the schema; existing rows are untouched
//   - MailLog.dedupeKey                       new optional field with a partial unique index
// What it does: builds the new indexes (idempotent) and reports counts a human can eyeball before and after.
// Run it on a FRESH CLONE first (migration rehearsal #2); it never deletes or rewrites a document.
//
//   npm run migrate:sprint14 -- --dry-run     report only, builds nothing
//   npm run migrate:sprint14                  build indexes + report
//   npm run migrate:sprint14 -- --rollback    drop only the indexes this script created (data is untouched, and the
//                                             previous release ignores every new field, so rollback needs nothing else)
export const SPRINT14_INDEXES = [
  { model: "Notification", index: "userId_1_workspaceId_1_read_1_createdAt_-1" },
  { model: "MailLog", index: "dedupeKey_1" },
  { model: "SavedChart", index: "formId_1_order_1_createdAt_1" },
] as const;

export const report = async () => ({
  forms: await Form.countDocuments({}).setOptions({ includeDeleted: true }),
  formsWithTemplateLink: await Form.countDocuments({ templateId: { $ne: null } }).setOptions({ includeDeleted: true }),
  notifications: await Notification.countDocuments({}),
  notificationsWithoutWorkspace: await Notification.countDocuments({ workspaceId: null }),
  savedCharts: await SavedChart.countDocuments({}),
  mailLogsWithDedupeKey: await MailLog.countDocuments({ dedupeKey: { $type: "string" } }),
});

export const migrateSprint14 = async (options: { dryRun?: boolean } = {}) => {
  const before = await report();
  if (!options.dryRun) {
    await Promise.all([Notification.createIndexes(), MailLog.createIndexes(), SavedChart.createIndexes()]);
  }
  return { before, after: await report() };
};

export const rollbackSprint14 = async (): Promise<string[]> => {
  const dropped: string[] = [];
  for (const { model, index } of SPRINT14_INDEXES) {
    try {
      await mongoose.model(model).collection.dropIndex(index);
      dropped.push(`${model}.${index}`);
    } catch {
      // index not present: already rolled back
    }
  }
  return dropped;
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
    if (process.argv.includes("--rollback")) {
      console.log("Dropped indexes:", await rollbackSprint14());
    } else {
      const dryRun = process.argv.includes("--dry-run");
      console.log(dryRun ? "[dry run]" : "Migrated.", JSON.stringify(await migrateSprint14({ dryRun }), null, 2));
    }
    await mongoose.disconnect();
  };
  run().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
