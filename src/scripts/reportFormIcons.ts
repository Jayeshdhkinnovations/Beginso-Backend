// READ-ONLY. Counts how many forms show a mark: a logo, a stored icon, a deliberate "No icon", or nothing. Counts only: no title, owner or answer is read or printed.
//
//   npm run report:form-icons
//
// Safe to run against production: it only reads. The month list shows where forms started to carry a stored icon (the Create form page stored the icon that
// suited the name without asking), to help decide whether to switch existing forms with `npm run migrate:form-icons-none`.
import mongoose from "mongoose";
import dotenv from "dotenv";
import { countFormIcons, type FormIconCounts } from "../services/formIcon.service";

dotenv.config();

export function describeIconCounts(c: FormIconCounts): string[] {
  const pct = (n: number) => (c.forms ? `${Math.round((n / c.forms) * 100)}%` : "0%");
  const lines = [
    `Forms (not in Trash): ${c.forms}   (in Trash, not counted below: ${c.trashed})`,
    `  with a logo                              ${c.withLogo}  (${pct(c.withLogo)})`,
    `  no logo, a stored icon                   ${c.withIcon}  (${pct(c.withIcon)})`,
    `  chose "No icon"                          ${c.iconNone}  (${pct(c.iconNone)})`,
    `  no logo, no icon, never chose (no mark)  ${c.neither}  (${pct(c.neither)})`,
  ];
  if (c.iconByMonth.length) {
    lines.push("Forms with a stored icon (no logo), by month created:");
    for (const m of c.iconByMonth) lines.push(`  ${m.month}  ${m.count}`);
  }
  return lines;
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/onboarding";
  try {
    await mongoose.connect(uri);
    for (const line of describeIconCounts(await countFormIcons())) console.log(line);
  } catch (error) {
    console.error("Report failed:", (error as Error).message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) void main();
