import mongoose from "mongoose";
import crypto from "crypto";
import dotenv from "dotenv";
import User from "../models/User";
import Form from "../models/Form";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Invitation from "../models/Invitation";

export interface MigrationOptions {
  dryRun?: boolean;
  rollback?: boolean;
  // Legacy behaviour: give every user who has no workspace one, and move their personal forms into
  // it. Off by default: workspaces are created lazily (C1.3 / C3.4), so by default the migration
  // only gives owners of existing workspaces the Membership row the permission layer expects.
  createWorkspaces?: boolean;
  // Rollback a migrated workspace even if it has gained members, invitations or forms since.
  force?: boolean;
}

export interface MigrationResult {
  success: boolean;
  dryRun: boolean;
  rollback: boolean;
  scannedUsers: number;
  usersMigrated: number;
  workspacesCreated: number;
  membershipsCreated: number;
  membershipsBackfilled: number;
  formsUpdated: number;
  workspacesRolledBack: number;
  rollbacksSkipped: number;
  errors: string[];
  details: string[];
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------------------------
// Rollback: only undoes what this migration recorded on the workspace it created.
// ---------------------------------------------------------------------------------------------
const rollbackMigration = async (options: MigrationOptions, result: MigrationResult): Promise<MigrationResult> => {
  const isDryRun = !!options.dryRun;

  for await (const ws of Workspace.find({ "metadata.migratedFromV1": true }).cursor()) {
    try {
      const wsId = ws._id;
      const recorded: string[] | undefined = ws.metadata?.migratedFormIds;
      const migratedAt = ws.metadata?.migratedAt ? new Date(ws.metadata.migratedAt) : null;
      const ownerId = String(ws.owner);

      // Workspaces migrated before the form list was recorded: their forms are the owner's forms
      // that already existed when the migration ran.
      const isMigratedForm = (f: any): boolean =>
        recorded
          ? recorded.includes(String(f._id))
          : !!migratedAt && String(f.createdBy) === ownerId && new Date(f.createdAt) <= migratedAt;

      const forms = await Form.find({ workspaceId: wsId }).select("_id createdBy createdAt").lean();
      const foreignForms = forms.filter((f) => !isMigratedForm(f));
      const otherMembers = await Membership.countDocuments({ workspaceId: wsId, userId: { $ne: ws.owner } });
      const pendingInvites = await Invitation.countDocuments({ workspaceId: wsId, status: "pending" });

      const reasons: string[] = [];
      if (foreignForms.length) reasons.push(`${foreignForms.length} form(s) created after the migration`);
      if (otherMembers) reasons.push(`${otherMembers} other member(s)`);
      if (pendingInvites) reasons.push(`${pendingInvites} pending invitation(s)`);

      if (reasons.length && !options.force) {
        result.rollbacksSkipped += 1;
        result.details.push(`SKIPPED workspace ${wsId}: it now has ${reasons.join(", ")}. Use --force to roll back anyway.`);
        continue;
      }

      const formIds = (options.force ? forms : forms.filter(isMigratedForm)).map((f) => f._id);
      result.formsUpdated += formIds.length;
      result.workspacesRolledBack += 1;
      result.details.push(`${isDryRun ? "Would roll back" : "Rolled back"} workspace ${wsId} (owner ${ws.owner}, ${formIds.length} form(s))`);
      if (isDryRun) continue;

      await Form.updateMany({ _id: { $in: formIds } }, { $unset: { workspaceId: 1 } });
      await Membership.deleteMany({ workspaceId: wsId });
      if (options.force) await Invitation.deleteMany({ workspaceId: wsId });
      await User.updateMany({ workspaceId: wsId }, { $unset: { workspaceId: 1 } });
      await Workspace.deleteOne({ _id: wsId });
    } catch (err) {
      result.success = false;
      result.errors.push(`rollback of workspace ${ws._id}: ${message(err)}`);
    }
  }

  result.details.push(
    `${isDryRun ? "Rollback dry-run" : "Rollback"} complete: ${result.workspacesRolledBack} rolled back, ${result.rollbacksSkipped} skipped.`
  );
  return result;
};

// ---------------------------------------------------------------------------------------------
// Forward migration. Idempotent: every step checks before it writes.
// ---------------------------------------------------------------------------------------------
export const runV1Migration = async (options: MigrationOptions = {}): Promise<MigrationResult> => {
  const isDryRun = !!options.dryRun;
  const result: MigrationResult = {
    success: true,
    dryRun: isDryRun,
    rollback: !!options.rollback,
    scannedUsers: 0,
    usersMigrated: 0,
    workspacesCreated: 0,
    membershipsCreated: 0,
    membershipsBackfilled: 0,
    formsUpdated: 0,
    workspacesRolledBack: 0,
    rollbacksSkipped: 0,
    errors: [],
    details: [],
  };

  if (options.rollback) return rollbackMigration(options, result);

  // Step 1: every existing workspace gets the owner Membership the permission layer relies on
  // (until this runs it falls back to the legacy "workspace.owner" check).
  for await (const ws of Workspace.find({}).select("_id owner").lean().cursor()) {
    try {
      if (await Membership.exists({ userId: ws.owner, workspaceId: ws._id })) continue;
      result.membershipsBackfilled += 1;
      result.details.push(`Workspace ${ws._id} has no owner membership for ${ws.owner}`);
      if (!isDryRun) {
        await Membership.updateOne(
          { userId: ws.owner, workspaceId: ws._id },
          { $setOnInsert: { role: "owner", notificationPreference: "all" } },
          { upsert: true }
        );
      }
    } catch (err) {
      result.success = false;
      result.errors.push(`owner membership for workspace ${ws._id}: ${message(err)}`);
    }
  }

  // Step 2 (opt-in): a workspace for every user that has none.
  if (options.createWorkspaces) {
    for await (const user of User.find({}).select("_id email fullName").lean().cursor()) {
      result.scannedUsers += 1;
      const userId = user._id;
      let createdWsId: mongoose.Types.ObjectId | null = null;
      let movedFormIds: mongoose.Types.ObjectId[] = [];

      try {
        if ((await Membership.exists({ userId })) || (await Workspace.exists({ owner: userId }))) continue;

        const orphanForms = await Form.find({
          createdBy: userId,
          $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }],
        })
          .select("_id")
          .lean();
        movedFormIds = orphanForms.map((f) => f._id as mongoose.Types.ObjectId);

        result.usersMigrated += 1;
        result.details.push(`User ${user.email} (${userId}) needs a workspace (personal forms: ${movedFormIds.length})`);

        if (isDryRun) {
          result.workspacesCreated += 1;
          result.membershipsCreated += 1;
          result.formsUpdated += movedFormIds.length;
          continue;
        }

        const ws = await Workspace.create({
          name: user.fullName ? `${user.fullName}'s Workspace` : `Workspace-${user.email.split("@")[0]}`,
          slug: `ws-${String(userId).substring(0, 8)}-${crypto.randomBytes(3).toString("hex")}`,
          owner: userId,
          metadata: { migratedFromV1: true, migratedAt: new Date(), migratedFormIds: movedFormIds.map(String) },
        } as any);
        createdWsId = ws._id as mongoose.Types.ObjectId;

        await Membership.create({ userId, workspaceId: ws._id, role: "owner", notificationPreference: "all" });
        if (movedFormIds.length) {
          await Form.updateMany({ _id: { $in: movedFormIds } }, { $set: { workspaceId: ws._id } });
        }
        await User.updateOne({ _id: userId }, { $set: { workspaceId: ws._id } });

        result.workspacesCreated += 1;
        result.membershipsCreated += 1;
        result.formsUpdated += movedFormIds.length;
      } catch (err) {
        result.success = false;
        result.errors.push(`user ${user.email}: ${message(err)}`);
        // Leave the user re-processable: a half-migrated user (workspace but forms not moved)
        // would be skipped forever by the "already has a workspace" check.
        if (createdWsId) {
          await Form.updateMany({ _id: { $in: movedFormIds }, workspaceId: createdWsId }, { $unset: { workspaceId: 1 } }).catch(() => {});
          await Membership.deleteMany({ workspaceId: createdWsId }).catch(() => {});
          await Workspace.deleteOne({ _id: createdWsId }).catch(() => {});
          await User.updateOne({ _id: userId, workspaceId: createdWsId }, { $unset: { workspaceId: 1 } }).catch(() => {});
        }
      }
    }
  }

  result.details.push(
    `${isDryRun ? "Dry-run" : "Migration"} complete: ${result.membershipsBackfilled} owner membership(s) backfilled` +
      (options.createWorkspaces ? `, ${result.workspacesCreated} workspace(s) created, ${result.formsUpdated} form(s) linked` : "") +
      (result.errors.length ? `, ${result.errors.length} error(s)` : "") +
      "."
  );
  return result;
};

// ---------------------------------------------------------------------------------------------
// CLI:  node dist/scripts/migrateV1ToMemberships.js --dry-run
//       node dist/scripts/migrateV1ToMemberships.js --yes [--create-workspaces]
//       node dist/scripts/migrateV1ToMemberships.js --rollback --dry-run | --rollback --yes [--force]
// ---------------------------------------------------------------------------------------------
if (require.main === module) {
  dotenv.config();
  const args = process.argv.slice(2);
  const has = (flag: string) => args.includes(flag);

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("Set MONGODB_URI (or MONGO_URI). Refusing to guess which database to change.");
    process.exit(1);
  }

  const options: MigrationOptions = {
    dryRun: has("--dry-run"),
    rollback: has("--rollback"),
    createWorkspaces: has("--create-workspaces"),
    force: has("--force"),
  };

  console.log(`Target database: ${uri.replace(/\/\/[^@/]*@/, "//***@")}`);
  if (!options.dryRun && !has("--yes")) {
    console.error("This changes data. Run with --dry-run first, then repeat with --yes to apply.");
    process.exit(1);
  }

  mongoose
    .connect(uri)
    .then(async () => {
      const res = await runV1Migration(options);
      console.log(JSON.stringify(res, null, 2));
      await mongoose.disconnect();
      process.exit(res.success ? 0 : 2);
    })
    .catch((err) => {
      console.error("Migration error:", err);
      process.exit(1);
    });
}
