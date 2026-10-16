import mongoose from "mongoose";
import dotenv from "dotenv";
import Invitation from "../models/Invitation";

// QA A9-001: new invitations store only `tokenHash` (never `token`). A database that still has an OLD unique index on
// `token` (or `tokenHash`) WITHOUT `sparse: true` treats every missing value as null, so the second invitation ever
// created collides with the first and every send answers 409 "already pending". Mongoose never changes an existing
// index whose options differ, so the stale ones stay until they are dropped. This script drops exactly those and
// rebuilds all indexes from the model. It never touches a document, and it is idempotent.
//
//   npm run migrate:invitation-indexes -- --dry-run     report the stale indexes only
//   npm run migrate:invitation-indexes                  drop the stale ones, rebuild from the model
//
// Run it once on EVERY environment (local, staging, production). Safe to re-run.
type IndexInfo = { name?: string; unique?: boolean; sparse?: boolean; partialFilterExpression?: unknown };

export const staleInvitationIndexes = async (): Promise<string[]> => {
  let indexes: IndexInfo[];
  try {
    indexes = (await Invitation.collection.indexes()) as IndexInfo[];
  } catch {
    return []; // collection does not exist yet: nothing stale
  }
  return indexes
    .filter((i) => {
      if (i.name === "token_1" || i.name === "tokenHash_1") return i.unique && !i.sparse && !i.partialFilterExpression;
      if (i.name === "workspaceId_1_email_1") return i.unique && !i.partialFilterExpression; // must be pending-only
      return false;
    })
    .map((i) => i.name as string);
};

export const migrateInvitationIndexes = async (options: { dryRun?: boolean } = {}) => {
  const stale = await staleInvitationIndexes();
  if (options.dryRun) return { stale, dropped: [] as string[] };
  for (const name of stale) await Invitation.collection.dropIndex(name);
  await Invitation.createIndexes();
  return { stale, dropped: stale };
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
    console.log(dryRun ? "[dry run]" : "Migrated.", JSON.stringify(await migrateInvitationIndexes({ dryRun }), null, 2));
    await mongoose.disconnect();
  };
  run().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
