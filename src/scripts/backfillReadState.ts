import mongoose from "mongoose";
import dotenv from "dotenv";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Membership from "../models/Membership";
import ResponseReadState from "../models/ResponseReadState";

// Sprint 12, BE 0.2 migration (B8.2, OQ-4). Every existing response defaults to READ for every
// current member of its workspace, so introducing per-user unread state doesn't confront anyone
// with a first-login wall of unread responses. Idempotent: uses $setOnInsert via bulkWrite, so a
// row that already exists (e.g. a user who genuinely read it before this ran) is left untouched
// and re-running only fills in gaps.
export interface BackfillResult {
  workspacesProcessed: number;
  rowsWritten: number;
}

export const backfillReadState = async (): Promise<BackfillResult> => {
  let workspacesProcessed = 0;
  let rowsWritten = 0;

  const workspaces = await Workspace.find().select("_id").lean();

  for (const ws of workspaces) {
    const memberships = await Membership.find({ workspaceId: ws._id }).select("userId").lean();
    if (memberships.length === 0) continue;
    const userIds = memberships.map((m) => m.userId);

    const formIds = (await Form.find({ workspaceId: ws._id }).select("_id").lean()).map((f) => f._id);
    if (formIds.length === 0) continue;

    const responseIds = (await ResponseModel.find({ formId: { $in: formIds } }).select("_id").lean()).map((r) => r._id);
    if (responseIds.length === 0) continue;

    workspacesProcessed += 1;

    const readAt = new Date();
    const ops: any[] = [];
    for (const responseId of responseIds) {
      for (const userId of userIds) {
        ops.push({
          updateOne: {
            filter: { userId, responseId },
            update: { $setOnInsert: { userId, responseId, readAt } },
            upsert: true,
          },
        });
      }
    }

    // bulkWrite in chunks to keep any single request bounded.
    const CHUNK = 1000;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const result = await ResponseReadState.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
      rowsWritten += result.upsertedCount || 0;
    }
  }

  return { workspacesProcessed, rowsWritten };
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
    const result = await backfillReadState();
    console.log(
      `Backfilled read state for ${result.workspacesProcessed} workspace(s); wrote ${result.rowsWritten} row(s).`
    );
    await mongoose.disconnect();
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
