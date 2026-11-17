// One-time, OPTIONAL switch of existing forms to "No icon". A dry run unless --apply is given.
//
//   npm run migrate:form-icons-none                                   dry run: how many forms it would switch, nothing written
//   npm run migrate:form-icons-none -- --created-after 2026-10-01     only forms created on or after that day
//   npm run migrate:form-icons-none -- --created-before 2026-11-04    only forms created before that day
//   npm run migrate:form-icons-none -- --apply                        does it
//
// Switches forms that store an icon and have no logo; their stored icon and its colour are removed and iconNone is set. A form with a logo, a form in Trash and a
// form that already chose "No icon" are never touched. Nothing else on the form changes. In production, --apply also needs ALLOW_FORM_ICON_MIGRATION=true.
// Run `npm run report:form-icons` first to see the numbers. Undo: there is no automatic undo (the removed icon names are not kept), which is why the dry run is the default.
import mongoose from "mongoose";
import dotenv from "dotenv";
import { applyFormIconMigration } from "../services/formIcon.service";

dotenv.config();

export const wantsApply = (argv: string[]): boolean => argv.includes("--apply");
export const refusesProductionWrite = (apply: boolean, env: NodeJS.ProcessEnv): boolean => apply && env.NODE_ENV === "production" && env.ALLOW_FORM_ICON_MIGRATION !== "true";
export const valueOf = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function main() {
  const argv = process.argv.slice(2);
  const apply = wantsApply(argv);
  if (refusesProductionWrite(apply, process.env)) {
    console.error('Refusing to write: NODE_ENV is "production". Set ALLOW_FORM_ICON_MIGRATION=true for this one run if you really mean it.');
    process.exit(1);
  }
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/onboarding";
  try {
    await mongoose.connect(uri);
    const result = await applyFormIconMigration({ createdAfter: valueOf(argv, "--created-after"), createdBefore: valueOf(argv, "--created-before") }, { apply });
    console.log(result.applied ? `Switched ${result.switched} forms to "No icon".` : `Dry run (nothing written): ${result.wouldSwitch} forms would be switched. Run again with --apply to do it.`);
  } catch (error) {
    console.error("Migration failed:", (error as Error).message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) void main();
