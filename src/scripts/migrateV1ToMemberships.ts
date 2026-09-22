import mongoose from "mongoose";
import User from "../models/User";
import Form from "../models/Form";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";

export interface MigrationOptions {
  dryRun?: boolean;
  rollback?: boolean;
}

export interface MigrationResult {
  success: boolean;
  dryRun: boolean;
  rollback: boolean;
  scannedUsers: number;
  usersMigrated: number;
  workspacesCreated: number;
  membershipsCreated: number;
  formsUpdated: number;
  details: string[];
}

export const runV1Migration = async (options: MigrationOptions = {}): Promise<MigrationResult> => {
  const isDryRun = !!options.dryRun;
  const isRollback = !!options.rollback;
  const result: MigrationResult = {
    success: true,
    dryRun: isDryRun,
    rollback: isRollback,
    scannedUsers: 0,
    usersMigrated: 0,
    workspacesCreated: 0,
    membershipsCreated: 0,
    formsUpdated: 0,
    details: [],
  };

  if (isRollback) {
    // Rollback mode: revert workspaces created by migration marker
    const migratedWorkspaces = await Workspace.find({ "metadata.migratedFromV1": true });
    for (const ws of migratedWorkspaces) {
      const wsId = ws._id;
      // Revert forms attached to this workspace
      const formUpdate = await Form.updateMany(
        { workspaceId: wsId },
        { $unset: { workspaceId: 1 } }
      );
      result.formsUpdated += formUpdate.modifiedCount;

      // Delete created memberships & workspace
      await Membership.deleteMany({ workspaceId: wsId });
      await Workspace.findByIdAndDelete(wsId);
      result.workspacesCreated += 1;
      result.details.push(`Rolled back workspace ${wsId} for user ${ws.owner}`);
    }

    // Clear workspaceId from users set by migration
    await User.updateMany(
      { "metadata.migratedFromV1": true },
      { $unset: { workspaceId: 1, "metadata.migratedFromV1": 1 } }
    );

    result.details.push("Migration rollback completed cleanly.");
    return result;
  }

  // Normal / Dry-Run mode
  const users = await User.find({});
  result.scannedUsers = users.length;

  for (const user of users) {
    const userId = user._id;

    // Check existing membership or workspace ownership
    const existingMembership = await Membership.findOne({ userId });
    const existingOwnedWs = await Workspace.findOne({ owner: userId });

    if (existingMembership || existingOwnedWs) {
      continue;
    }

    // Check if user has forms needing workspace association
    const orphanForms = await Form.find({
      createdBy: userId,
      $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }],
    });

    result.usersMigrated += 1;
    result.details.push(`User ${user.email} (${userId}) needs workspace (orphan forms: ${orphanForms.length})`);

    if (!isDryRun) {
      // Create new personal workspace for V1 user
      const wsName = user.fullName ? `${user.fullName}'s Workspace` : `Workspace-${user.email.split("@")[0]}`;
      const slug = `ws-${userId.toString().substring(0, 8)}-${Date.now()}`;

      const newWs: any = await Workspace.create({
        name: wsName,
        slug,
        owner: userId,
        metadata: { migratedFromV1: true, migratedAt: new Date() },
      } as any);

      result.workspacesCreated += 1;

      // Create owner membership
      await Membership.create({
        userId,
        workspaceId: newWs._id,
        role: "owner",
      });
      result.membershipsCreated += 1;

      // Associate user's orphan forms with new workspace
      if (orphanForms.length > 0) {
        const updateRes = await Form.updateMany(
          { _id: { $in: orphanForms.map((f) => f._id) } },
          { $set: { workspaceId: newWs._id } }
        );
        result.formsUpdated += updateRes.modifiedCount;
      }

      // Update user primary workspace reference
      user.workspaceId = newWs._id as any;
      if (!(user as any).metadata) (user as any).metadata = {};
      (user as any).metadata.migratedFromV1 = true;
      await user.save();
    } else {
      result.workspacesCreated += 1;
      result.membershipsCreated += 1;
      result.formsUpdated += orphanForms.length;
    }
  }

  result.details.push(
    isDryRun
      ? `Dry-run complete: ${result.usersMigrated} users require workspace creation.`
      : `Migration complete: ${result.workspacesCreated} workspaces created, ${result.formsUpdated} forms linked.`
  );

  return result;
};

// CLI entry point if run directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rollback = args.includes("--rollback");

  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/beginso";
  mongoose
    .connect(mongoUri)
    .then(async () => {
      console.log(`Starting V1 Migration (dryRun: ${dryRun}, rollback: ${rollback})...`);
      const res = await runV1Migration({ dryRun, rollback });
      console.log(JSON.stringify(res, null, 2));
      await mongoose.disconnect();
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration error:", err);
      process.exit(1);
    });
}
