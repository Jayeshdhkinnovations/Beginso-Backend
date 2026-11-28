// Switches the older templates that a wave sync switched off back ON. A dry run unless --apply is given. It never deletes and changes only isActive.
//
//   npm run reactivate:templates                          dry run: lists the 13 older templates that would be switched on
//   npm run reactivate:templates -- --slugs a,b           only those slugs (built-in templates only)
//   npm run reactivate:templates -- --apply               does it
//
// In production, --apply also needs ALLOW_TEMPLATE_SYNC=true for that run. Note: running a wave sync again (--wave N --apply) switches them off again.
import mongoose from "mongoose";
import dotenv from "dotenv";
import { reactivateTemplates, replacedSlugs, type ReactivationResult } from "../services/templateReactivate.service";

dotenv.config();

export const wantsApply = (argv: string[]): boolean => argv.includes("--apply");
export const refusesProductionWrite = (apply: boolean, env: NodeJS.ProcessEnv): boolean => apply && env.NODE_ENV === "production" && env.ALLOW_TEMPLATE_SYNC !== "true";

/** The slugs after --slugs (comma separated), or undefined when the flag is absent (then the replaced older templates are used). */
export function slugsOf(argv: string[]): string[] | undefined {
  const i = argv.indexOf("--slugs");
  if (i < 0) return undefined;
  return (argv[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function describeReactivation(r: ReactivationResult): string[] {
  const lines = [r.applied ? "Applied:" : "Dry run (nothing written). Run again with --apply to do this:"];
  lines.push(`  switched on  ${r.applied ? r.switchedOn : r.toSwitchOn.length}${r.toSwitchOn.length ? `  (${r.toSwitchOn.join(", ")})` : ""}`);
  lines.push(`  already on   ${r.alreadyOn.length}`);
  if (r.missing.length) lines.push(`  not found    ${r.missing.length}  (${r.missing.join(", ")})`);
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = wantsApply(argv);
  if (refusesProductionWrite(apply, process.env)) {
    console.error('Refusing to write: NODE_ENV is "production". Set ALLOW_TEMPLATE_SYNC=true for this one run if you really mean it.');
    process.exit(1);
  }
  const slugs = slugsOf(argv);
  if (slugs && slugs.length === 0) {
    console.error("--slugs needs a comma separated list, for example --slugs contact-sales,donation-form");
    process.exit(1);
  }
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/onboarding";
  try {
    await mongoose.connect(uri);
    const result = await reactivateTemplates(slugs ?? replacedSlugs(), { apply });
    for (const line of describeReactivation(result)) console.log(line);
  } catch (error) {
    console.error("Reactivation failed:", (error as Error).message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) void main();
