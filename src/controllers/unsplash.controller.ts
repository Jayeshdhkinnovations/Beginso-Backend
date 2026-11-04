import { Request, Response } from "express";
import { featuredPhotos, searchPhotos, trackDownload, UnsplashError } from "../services/unsplash.service";

// GET /api/unsplash/search?q=&page=   POST /api/unsplash/download { id }
// Signed-in people only (the studio's picture picker). The Access Key never leaves the server.

const fail = (res: Response, err: unknown, fallback: string) => {
  if (err instanceof UnsplashError) {
    res.status(err.status).json({ success: false, message: err.message, error: { code: err.code, message: err.message } });
    return;
  }
  console.error(fallback, err);
  res.status(500).json({ success: false, message: fallback });
};

export const search = async (req: Request, res: Response): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const pageText = typeof req.query.page === "string" ? req.query.page : undefined;
  const pageRaw = pageText === undefined ? 1 : /^\d{1,2}$/.test(pageText) ? parseInt(pageText, 10) : NaN;
  if (q.length > 80) {
    res.status(400).json({ success: false, message: "Search words are too long" });
    return;
  }
  if (req.query.page !== undefined && (!Number.isInteger(pageRaw) || pageRaw < 1 || pageRaw > 50)) {
    res.status(400).json({ success: false, message: "page must be a whole number from 1 to 50" });
    return;
  }
  try {
    res.status(200).json({ success: true, data: await searchPhotos(q, pageRaw || 1) });
  } catch (err) {
    fail(res, err, "Error searching photos");
  }
};

export const featured = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.status(200).json({ success: true, data: { photos: await featuredPhotos() } });
  } catch (err) {
    fail(res, err, "Error loading photos");
  }
};

export const download = async (req: Request, res: Response): Promise<void> => {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (!/^[A-Za-z0-9_-]{6,24}$/.test(id)) {
    res.status(400).json({ success: false, message: "id is not a photo id" });
    return;
  }
  await trackDownload(id);
  res.status(204).end();
};
