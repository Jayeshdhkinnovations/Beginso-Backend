import mongoose from "mongoose";
import dotenv from "dotenv";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import StageModel from "../models/Stage";
import { DEFAULT_STAGE_SEEDS } from "../services/stage.service";

// Sprint 12, BE 0.1 migration. In order:
//   1. Seed the 3 default stages for every workspace that has none yet.
//   2. Map every existing response's `status` onto the matching-category stage of its own
//      workspace and set `stageId`. Idempotent: only touches responses with no stageId yet, so
//      it is safe to re-run (e.g. after seeding more workspaces).
//   3. Assert per-status counts (before) == per-stage-category counts (after) and throw if not —
//      this must fail loudly, not continue with a silently wrong migration.
//
// Rollback (manual, not automated — a full rehearsal-on-clone is a later/Friday task):
//   - `db.responses.updateMany({}, { $unset: { stageId: "" } })` drops the new field; `status`
//     was never removed, so every pre-Sprint-12 consumer keeps working immediately.
//   - Extra stages created by THIS script (not ones an admin created by hand afterwards) can be
//     identified by `isDefault` plus workspaces where `createdAt` matches the migration run, and
//     deleted with `db.stages.deleteMany({ workspaceId: <id> })` per affected workspace. Do this
//     only after `stageId` has been unset on every response, otherwise you delete stages that
//     responses still point to.

const CATEGORIES = ["new", "in_progress", "completed"] as const;
type Category = (typeof CATEGORIES)[number];

export interface MigrationResult {
  workspacesSeeded: number;
  responsesMigrated: number;
}

export const migrateStagesFromStatus = async (): Promise<MigrationResult> => {
  // Snapshot per-status counts BEFORE any write, for the post-migration assertion.
  const beforeCounts = await ResponseModel.aggregate([
    { $group: { _id: { $ifNull: ["$status", "new"] }, count: { $sum: 1 } } },
  ]);
  const beforeByStatus = new Map<string, number>(beforeCounts.map((c: any) => [c._id, c.count]));

  let workspacesSeeded = 0;
  let responsesMigrated = 0;

  const workspaces = await Workspace.find().select("_id").lean();

  for (const ws of workspaces) {
    const workspaceId = ws._id;

    const existingStageCount = await StageModel.countDocuments({ workspaceId });
    if (existingStageCount === 0) {
      await StageModel.insertMany(
        DEFAULT_STAGE_SEEDS.map((s) => ({ ...s, workspaceId }))
      );
      workspacesSeeded += 1;
    }

    const stages = await StageModel.find({ workspaceId });
    const stageByCategory = new Map<Category, (typeof stages)[number]>(
      stages.map((s) => [s.category as Category, s])
    );

    const formIds = (await Form.find({ workspaceId }).select("_id").lean()).map((f) => f._id);
    if (formIds.length === 0) continue;

    for (const category of CATEGORIES) {
      const stage = stageByCategory.get(category);
      // A workspace whose pre-existing (hand-created) stages happen to omit a category is left
      // alone on Day 1 rather than auto-repaired — that is a data-quality call for a human, not
      // something this script should decide silently.
      if (!stage) continue;

      const statusMatch =
        category === "new"
          ? { $or: [{ status: "new" }, { status: { $exists: false } }, { status: null }] }
          : { status: category };

      const result = await ResponseModel.updateMany(
        { formId: { $in: formIds }, stageId: { $exists: false }, ...statusMatch },
        { $set: { stageId: stage._id } }
      );
      responsesMigrated += result.modifiedCount;
    }
  }

  // Assert: per-status counts before must equal per-stage-category counts after. A mismatch means
  // responses were lost, double-counted, or mapped to the wrong category — refuse to continue.
  const afterCounts = await ResponseModel.aggregate([
    { $match: { stageId: { $exists: true } } },
    { $lookup: { from: StageModel.collection.name, localField: "stageId", foreignField: "_id", as: "stage" } },
    { $unwind: "$stage" },
    { $group: { _id: "$stage.category", count: { $sum: 1 } } },
  ]);
  const afterByCategory = new Map<string, number>(afterCounts.map((c: any) => [c._id, c.count]));

  const mismatches: string[] = [];
  for (const category of CATEGORIES) {
    const before = beforeByStatus.get(category) || 0;
    const after = afterByCategory.get(category) || 0;
    if (before !== after) {
      mismatches.push(`'${category}': ${before} before, ${after} after`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `migrateStagesFromStatus: per-status/per-stage count mismatch, refusing to report success: ${mismatches.join("; ")}`
    );
  }

  return { workspacesSeeded, responsesMigrated };
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
    const result = await migrateStagesFromStatus();
    console.log(
      `Seeded default stages for ${result.workspacesSeeded} workspace(s); set stageId on ${result.responsesMigrated} response(s).`
    );
    await mongoose.disconnect();
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
