import fs from "fs";
import path from "path";
import Upload from "../models/Upload";
import { getUploadDir } from "../controllers/upload.controller";
import { assertStorageQuota } from "./storage.service";

// A form's logo, cover and background are files stored inside THAT form's own folder (<owner>/<formId>/brand/...), and
// deleting the form deletes the folder. A duplicate that copied only the URLs would point into the ORIGINAL's folder, so
// purging the original would silently break the copy's images. These give the copy its own files instead.
// It costs storage, charged like any other upload.

const PREFIX = "/api/upload/file/";
const BRANDING_URL_KEYS = ["logoUrl", "coverImageUrl", "backgroundImageUrl"] as const;

/** `<owner>/<formId>/<...>/<file>` for a URL that points into the given form's own folder, otherwise null. */
const insideFormFolder = (url: unknown, formId: string): string[] | null => {
  if (typeof url !== "string") return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(PREFIX)) return null;
  const segments = pathname.slice(PREFIX.length).split("/").map(decodeURIComponent);
  if (segments.length < 3 || segments[1] !== formId || segments.some((s) => !s || s === "..")) return null;
  return segments;
};

/**
 * Copies every branding image that lives in `fromFormId`'s folder into `toFormId`'s folder (new file, new Upload row) and
 * returns the branding with those URLs rewritten. Images that live elsewhere (a workspace default, an outside link) are
 * kept as they are: nothing deletes them with the original form. A file whose Upload row is missing is left shared
 * rather than copied blind. Throws the usual quota error before copying anything if there is no room.
 */
export const copyBrandingFiles = async (
  branding: Record<string, unknown> | undefined,
  fromFormId: string,
  toFormId: string
): Promise<Record<string, unknown> | undefined> => {
  if (!branding) return branding;
  const uploadDir = getUploadDir();
  const plan: { key: string; segments: string[]; row: any }[] = [];

  for (const key of BRANDING_URL_KEYS) {
    const segments = insideFormFolder(branding[key], fromFormId);
    if (!segments) continue;
    const row = await Upload.findOne({ path: { $in: [segments.join("/"), segments.join(path.sep)] } }).lean();
    const abs = path.resolve(uploadDir, ...segments);
    if (!row || !abs.startsWith(path.resolve(uploadDir) + path.sep) || !fs.existsSync(abs)) continue;
    plan.push({ key, segments, row });
  }
  if (plan.length === 0) return branding;

  const charged = plan[0].row.chargedTo ?? plan[0].row.owner;
  await assertStorageQuota(charged, { bytesToAdd: plan.reduce((sum, p) => sum + (p.row.size ?? 0), 0) });

  const next = { ...branding };
  const copied: string[] = [];
  try {
    for (const { key, segments, row } of plan) {
      const newSegments = segments.map((s, i) => (i === 1 ? toFormId : s));
      const src = path.resolve(uploadDir, ...segments);
      const dest = path.resolve(uploadDir, ...newSegments);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      copied.push(dest);
      await Upload.create({
        name: row.name,
        size: row.size,
        type: row.type,
        path: path.join(...newSegments),
        owner: row.owner,
        chargedTo: row.chargedTo ?? null,
        uploadTime: new Date(),
        isBranding: row.isBranding ?? true,
      });
      const url = new URL(branding[key] as string);
      url.pathname = PREFIX + newSegments.map(encodeURIComponent).join("/");
      next[key] = url.toString();
    }
  } catch (err) {
    // Leave nothing half-copied behind.
    for (const f of copied) fs.rmSync(f, { force: true });
    await Upload.deleteMany({ path: { $in: copied.map((f) => path.relative(uploadDir, f)) } });
    throw err;
  }
  return next;
};
