// One-off clean-up for the "owner downgraded by their own self-grant" bug (QA, Oct 2026).
// Finds FormAccessGrant rows whose grantee is the form's owner (personal form: createdBy; workspace form:
// the workspace owner) and deletes them. The access resolver now ignores such a grant, so this is data
// hygiene: it also lets the owner manage the form's grants again from the UI.
//
// DRY RUN BY DEFAULT: nothing is written unless --apply is passed. Never run against production without
// reading the dry-run output first. Known stuck production form: 6ac6036aae63dd7f0e97a3d7
// (restrict to it with --form-id 6ac6036aae63dd7f0e97a3d7).
//
//   MONGODB_URI=<uri> npx ts-node --transpile-only scratch/removeOwnerSelfGrants.ts                 (dry run, all forms)
//   MONGODB_URI=<uri> npx ts-node --transpile-only scratch/removeOwnerSelfGrants.ts --form-id <id>  (dry run, one form)
//   MONGODB_URI=<uri> npx ts-node --transpile-only scratch/removeOwnerSelfGrants.ts --form-id <id> --apply
import mongoose from "mongoose";
import dotenv from "dotenv";
import Form from "../src/models/Form";
import FormAccessGrant from "../src/models/FormAccessGrant";
import Workspace from "../src/models/Workspace";

dotenv.config();

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const run = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("Set MONGODB_URI (or MONGO_URI). Refusing to guess which database to change.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const onlyForm = arg("--form-id");
  if (onlyForm && !mongoose.Types.ObjectId.isValid(onlyForm)) {
    console.error("--form-id is not a valid ObjectId");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Mode: ${apply ? "APPLY (will delete)" : "dry run (no writes)"}${onlyForm ? `, form ${onlyForm}` : ", all forms"}`);

  const grants = await FormAccessGrant.find(onlyForm ? { formId: onlyForm } : {}).lean();
  const formIds = [...new Set(grants.map((g) => String(g.formId)))];
  // includeDeleted: a form in Trash comes back on restore, so its self-grant must go too.
  const forms = await Form.find({ _id: { $in: formIds } }).select("workspaceId createdBy").setOptions({ includeDeleted: true }).lean();
  const wsIds = [...new Set(forms.map((f: any) => f.workspaceId).filter(Boolean).map(String))];
  const owners = new Map((await Workspace.find({ _id: { $in: wsIds } }).select("owner").lean()).map((w: any) => [String(w._id), String(w.owner)]));
  const formById = new Map(forms.map((f: any) => [String(f._id), f]));

  const toDelete = grants.filter((g) => {
    const f: any = formById.get(String(g.formId));
    if (!f) return false;
    const ownerId = f.workspaceId ? owners.get(String(f.workspaceId)) : String(f.createdBy);
    return !!ownerId && String(g.userId) === ownerId;
  });

  for (const g of toDelete) console.log(`  self-grant ${g._id}: form ${g.formId}, user ${g.userId}, role ${g.role}`);
  console.log(`Self-grants found: ${toDelete.length} of ${grants.length} grants scanned.`);

  if (apply && toDelete.length) {
    const res = await FormAccessGrant.deleteMany({ _id: { $in: toDelete.map((g) => g._id) } });
    console.log(`Deleted ${res.deletedCount}.`);
  } else if (toDelete.length) {
    console.log("Dry run: re-run with --apply to delete.");
  }
  await mongoose.disconnect();
};

run().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
