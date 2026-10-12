import fs from "fs";

// image_upload accepts only these. The browser-reported MIME type and the file name are both
// client-controlled, so a file is also checked by its first bytes before it is kept.
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;
export const DEFAULT_IMAGE_MAX_MB = 10;

export const looksLikeImage = (filePath: string): boolean => {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const png = head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const webp = head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP";
    return jpeg || png || webp;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};
