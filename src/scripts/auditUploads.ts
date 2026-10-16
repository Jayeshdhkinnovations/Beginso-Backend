import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Upload from "../models/Upload";
import Form from "../models/Form";
import Workspace from "../models/Workspace";
import User from "../models/User";
import { getUploadDir } from "../controllers/upload.controller";
import { reconcileUser } from "../services/storage.service";

// Compares the Upload records with the files that really exist on disk, and (only with --apply) repairs what is safe to
// repair, then recomputes each affected user's storage counter.
//
//   npm run audit:uploads                dry run: reports everything, changes nothing  (always do this first)
//   npm run audit:uploads -- --apply     deletes records whose file is gone, collapses records that share one file
//                                        down to the newest, fixes record sizes to the real size, recomputes counters
//
// IT MUST RUN ON THE SERVER THAT HOLDS THE UPLOADS FOLDER (or with UPLOAD_DIR pointing at a copy of it). Run anywhere else,
// every record would look like it has no file. So --apply refuses to run when the folder is missing, or when more than
// MAX_MISSING_SHARE of the records have no file.
//
// It NEVER deletes a file, and it only REPORTS (never removes) files with no record and user images nothing refers to.

export const MAX_MISSING_SHARE = 0.2;

type Row = { _id: mongoose.Types.ObjectId; path: string; size: number; owner: mongoose.Types.ObjectId; chargedTo?: mongoose.Types.ObjectId | null; uploadTime: Date };

export interface UploadAudit {
  uploadDir: string;
  rows: number;
  /** Records whose file does not exist. */
  missingFile: { id: string; path: string; bytes: number }[];
  /** Groups of records that point at one and the same file (legacy: same name, same folder). */
  sharedPath: { path: string; rows: number; realBytes: number; chargedBytes: number }[];
  /** A single record whose size differs from the file's real size. */
  sizeMismatch: { id: string; path: string; recorded: number; real: number }[];
  /** Files on disk that no record points at (reported only). */
  orphanFiles: { path: string; bytes: number }[];
  /** User-level images (avatar, workspace default) that no form, workspace or profile refers to (reported only). */
  unreferencedUserImages: { path: string; owner: string; bytes: number }[];
  /** Per user: bytes the records claim vs what really sits on disk. */
  perUser: { userId: string; recordedBytes: number; realBytes: number; excessBytes: number }[];
  changed: boolean;
  refused?: string;
}

const norm = (p: string) => p.replace(/\\/g, "/");
const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "_staging" || e.name === "exports") continue; // scratch and generated files, not uploads
      walk(p, out);
    } else out.push(p);
  }
  return out;
};

export const auditUploads = async ({ apply = false, uploadDir = getUploadDir() } = {}): Promise<UploadAudit> => {
  const audit: UploadAudit = { uploadDir, rows: 0, missingFile: [], sharedPath: [], sizeMismatch: [], orphanFiles: [], unreferencedUserImages: [], perUser: [], changed: false };
  const rows = (await Upload.find({}).select("path size owner chargedTo uploadTime").lean()) as unknown as Row[];
  audit.rows = rows.length;

  const abs = (rel: string) => path.join(uploadDir, ...norm(rel).split("/"));
  const sizeOnDisk = (rel: string): number | null => {
    try {
      const st = fs.statSync(abs(rel));
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  };

  const byPath = new Map<string, Row[]>();
  for (const r of rows) byPath.set(norm(r.path), [...(byPath.get(norm(r.path)) ?? []), r]);

  const userOf = (r: Row) => String(r.chargedTo ?? r.owner);
  const per = new Map<string, { recorded: number; real: number }>();
  const bump = (u: string, recorded: number, real: number) => {
    const cur = per.get(u) ?? { recorded: 0, real: 0 };
    per.set(u, { recorded: cur.recorded + recorded, real: cur.real + real });
  };
  const toDelete: Row[] = [];
  const toResize: { id: mongoose.Types.ObjectId; size: number }[] = [];

  for (const [p, group] of byPath) {
    const real = sizeOnDisk(p);
    if (real === null) {
      for (const r of group) {
        audit.missingFile.push({ id: String(r._id), path: p, bytes: r.size });
        bump(userOf(r), r.size, 0);
        toDelete.push(r);
      }
      continue;
    }
    if (group.length > 1) {
      const newest = [...group].sort((a, b) => +new Date(b.uploadTime) - +new Date(a.uploadTime))[0];
      audit.sharedPath.push({ path: p, rows: group.length, realBytes: real, chargedBytes: group.reduce((n, r) => n + r.size, 0) });
      for (const r of group) bump(userOf(r), r.size, r === newest ? real : 0);
      for (const r of group) if (r !== newest) toDelete.push(r);
      if (newest.size !== real) toResize.push({ id: newest._id, size: real });
      continue;
    }
    const only = group[0];
    bump(userOf(only), only.size, real);
    if (only.size !== real) {
      audit.sizeMismatch.push({ id: String(only._id), path: p, recorded: only.size, real });
      toResize.push({ id: only._id, size: real });
    }
  }

  // Files nobody records.
  for (const file of walk(uploadDir)) {
    const rel = norm(path.relative(uploadDir, file));
    if (!byPath.has(rel)) audit.orphanFiles.push({ path: rel, bytes: fs.statSync(file).size });
  }

  // User-level images (<userId>/brand/<kind>/<file>) that nothing refers to.
  for (const [p, group] of byPath) {
    const seg = p.split("/");
    if (seg.length !== 4 || seg[1] !== "brand") continue;
    const ending = new RegExp(escapeRegex("/api/upload/file/" + p) + "$");
    const used =
      (await Form.exists({ $or: [{ "branding.logoUrl": ending }, { "branding.coverImageUrl": ending }, { "branding.backgroundImageUrl": ending }] }).setOptions({ includeDeleted: true })) ||
      (await Workspace.exists({ $or: [{ logo: ending }, { logoUrl: ending }, { "branding.logoUrl": ending }, { "branding.coverImageUrl": ending }] })) ||
      (await User.exists({ avatarUrl: ending }));
    if (!used) audit.unreferencedUserImages.push({ path: p, owner: String(group[0].owner), bytes: sizeOnDisk(p) ?? 0 });
  }

  audit.perUser = [...per]
    .map(([userId, v]) => ({ userId, recordedBytes: v.recorded, realBytes: v.real, excessBytes: v.recorded - v.real }))
    .filter((u) => u.excessBytes !== 0)
    .sort((a, b) => b.excessBytes - a.excessBytes);

  if (!apply) return audit;

  // Refuse to "repair" against a folder that is not the real one.
  if (!fs.existsSync(uploadDir)) return { ...audit, refused: `The uploads folder ${uploadDir} does not exist. Run this on the server that holds the uploads, or set UPLOAD_DIR.` };
  if (rows.length > 0 && audit.missingFile.length / rows.length > MAX_MISSING_SHARE) {
    return { ...audit, refused: `${audit.missingFile.length} of ${rows.length} records have no file in ${uploadDir}. That is far more than a few strays, so this is probably not the right uploads folder. Nothing was changed.` };
  }

  const affected = new Set<string>(toDelete.map(userOf));
  if (toDelete.length) await Upload.deleteMany({ _id: { $in: toDelete.map((r) => r._id) } });
  for (const r of toResize) await Upload.updateOne({ _id: r.id }, { $set: { size: r.size } });
  for (const r of toResize) {
    const row = rows.find((x) => String(x._id) === String(r.id));
    if (row) affected.add(userOf(row));
  }
  // Records are right now: recompute each affected user's running counter from them (this also absorbs the hooks' deltas).
  for (const u of affected) await reconcileUser(u);
  audit.changed = toDelete.length > 0 || toResize.length > 0;
  return audit;
};

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

if (require.main === module) {
  dotenv.config();
  const run = async () => {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
      console.error("Set MONGODB_URI (or MONGO_URI). Refusing to guess which database to change.");
      process.exit(1);
    }
    await mongoose.connect(mongoUri);
    const apply = process.argv.includes("--apply");
    const a = await auditUploads({ apply });
    console.log(`Uploads folder: ${a.uploadDir}  (${fs.existsSync(a.uploadDir) ? "found" : "NOT FOUND: this is not the folder the uploads live in"})`);
    console.log(`Records: ${a.rows}`);
    console.log(`Records with no file: ${a.missingFile.length}  (${mb(a.missingFile.reduce((n, r) => n + r.bytes, 0))} counted for nothing)`);
    console.log(`Files shared by several records: ${a.sharedPath.length}  (${mb(a.sharedPath.reduce((n, r) => n + r.chargedBytes - r.realBytes, 0))} charged twice)`);
    console.log(`Records with the wrong size: ${a.sizeMismatch.length}`);
    console.log(`Files with no record (reported only): ${a.orphanFiles.length}  (${mb(a.orphanFiles.reduce((n, r) => n + r.bytes, 0))})`);
    console.log(`User images nothing refers to (reported only): ${a.unreferencedUserImages.length}`);
    for (const u of a.unreferencedUserImages.slice(0, 20)) console.log(`   ${u.path}  ${mb(u.bytes)}`);
    console.log(`Users whose records claim more than the real files: ${a.perUser.length}`);
    for (const u of a.perUser.slice(0, 20)) console.log(`   ${u.userId}  recorded ${mb(u.recordedBytes)}  real ${mb(u.realBytes)}  excess ${mb(u.excessBytes)}`);
    if (a.refused) console.error(`\nREFUSED: ${a.refused}`);
    else console.log(apply ? (a.changed ? "\nRepaired." : "\nNothing needed repairing.") : "\nDry run: nothing was changed. Review the report, then run again with --apply on the uploads server.");
    await mongoose.disconnect();
    if (a.refused) process.exit(2);
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
