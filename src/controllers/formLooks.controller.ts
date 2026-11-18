import { Request, Response } from "express";
import { FORM_LOOKS, FORM_LOOKS_FILE_VERSION, FORM_LOOKS_VERSION } from "../utils/formLooks";

// GET /api/form-looks: the Looks, read-only and public (nothing in them belongs to a user). Cached for five minutes by browsers and an hour by a
// shared cache; the ETag is the file's fingerprint, so a client that already has this version gets a 304 and no body.
export const getFormLooks = (req: Request, res: Response): void => {
  const etag = `"looks-${FORM_LOOKS_VERSION}"`;
  res.set({ "Cache-Control": "public, max-age=300, s-maxage=3600", ETag: etag });
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  res.status(200).json({ success: true, version: FORM_LOOKS_FILE_VERSION, fingerprint: FORM_LOOKS_VERSION, data: FORM_LOOKS });
};
