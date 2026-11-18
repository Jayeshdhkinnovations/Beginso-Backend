// Brings the built-in templates in the database in step with the catalogue (data/builtInTemplates.ts) without deleting anything.
//
//   npm run sync:templates              dry run: prints what would be added, changed and deactivated, and writes nothing
//   npm run sync:templates -- --apply   does it
//   npm run sync:templates -- --wave 1  dry run of wave 1 only (1, 2 or 3); with --apply it adds or updates that wave and switches off the older templates it
//                                       replaces (never deletes). Without --wave only the older catalogue is synced: a wave that was not asked for stays untouched.
//
// In production, --apply also needs ALLOW_TEMPLATE_SYNC=true for that run. A dry run is always allowed (it only reads).
// Built-in templates only: a template a workspace published is never touched. See services/templateSync.service.ts.
import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { builtInTemplates } from "../data/builtInTemplates";
import { syncTemplates, type SyncResult } from "../services/templateSync.service";

dotenv.config();

export const wantsApply = (argv: string[]): boolean => argv.includes("--apply");

/** The wave asked for with --wave N (1, 2 or 3); undefined when the flag is absent; a message when its value is not 1, 2 or 3. */
export function waveOf(argv: string[]): { wave?: number; error?: string } {
  const i = argv.indexOf("--wave");
  if (i < 0) return {};
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? { wave: n } : { error: "--wave needs 1, 2 or 3" };
}

/** True when this run must be refused: a production write without the explicit flag. */
export const refusesProductionWrite = (apply: boolean, env: NodeJS.ProcessEnv): boolean => apply && env.NODE_ENV === "production" && env.ALLOW_TEMPLATE_SYNC !== "true";

export function describeSync(result: SyncResult): string[] {
  const scope = result.wave === undefined ? "the older catalogue" : "wave " + result.wave;
  const lines = [(result.applied ? "Applied" : "Dry run (nothing written). Run again with --apply to do this") + " for " + scope + ":"];
  lines.push(`  added        ${result.added.length}${result.added.length ? `  (${result.added.join(", ")})` : ""}`);
  lines.push(`  changed      ${result.changed.length}`);
  for (const c of result.changed) lines.push(`    - ${c.slug}: ${c.fields.join(", ")}`);
  lines.push(`  deactivated  ${result.deactivated.length}${result.deactivated.length ? `  (${result.deactivated.join(", ")})` : ""}`);
  lines.push(`  unchanged    ${result.unchanged}`);
  if (result.conflicts.length) lines.push(`  skipped (the slug belongs to a template that is not built-in): ${result.conflicts.join(", ")}`);
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = wantsApply(argv);
  const { wave, error } = waveOf(argv);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  if (refusesProductionWrite(apply, process.env)) {
    console.error('Refusing to write: NODE_ENV is "production". Set ALLOW_TEMPLATE_SYNC=true for this one run if you really mean it.');
    process.exit(1);
  }
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/onboarding";
  try {
    await mongoose.connect(mongoUri);
    const seedsPath = path.join(__dirname, "../../seeds.json");
    const pitch = fs.existsSync(seedsPath) ? JSON.parse(fs.readFileSync(seedsPath, "utf-8")) : { pages: [], fields: [] };
    const result = await syncTemplates(builtInTemplates(pitch), { apply, wave });
    for (const line of describeSync(result)) console.log(line);
  } catch (error) {
    console.error("Template sync failed:", (error as Error).message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) void main();
