import { Request, Response, NextFunction } from "express";
import { emptyTrash, listTrash, purgeItem, restoreItem, TrashScope, TrashType } from "../services/trash.service";

// Sprint 13, BE 0.9 (CF5.5). Trash endpoints. The route's requirePermission has already placed the caller
// in ONE context (a workspace they belong to, or their personal space) and set the request's workspace
// fields; this controller turns that into a TrashScope and lets the service apply the per-type role rules.

const scopeOf = (req: Request): TrashScope => {
  const authReq = req as any;
  const personal = authReq.explicitPersonalContext === true || !authReq.workspaceId;
  const user = authReq.user;
  return {
    workspaceId: personal ? null : String(authReq.workspaceId),
    userId: String(user._id),
    userEmail: user.email,
    userName: user.fullName || user.email,
    role: personal ? null : (authReq.workspaceRole ?? null),
  };
};

const parseType = (value: unknown): TrashType | null => (value === "form" || value === "response" ? value : null);

// The server re-checks the typed confirmation: the UI's "type DELETE" box is a convenience, not the guard.
const requireConfirm = (req: Request, res: Response): boolean => {
  if (req.body?.confirm === "DELETE") return true;
  res.status(400).json({
    success: false,
    message: 'Type "DELETE" to confirm permanent deletion',
    error: { code: "CONFIRMATION_REQUIRED", message: 'Type "DELETE" to confirm permanent deletion' },
  });
  return false;
};

// GET /api/trash?type=form|response&page=&limit=
export const getTrash = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const type = parseType(req.query.type) ?? undefined;
    const result = await listTrash(scopeOf(req), {
      type,
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

// POST /api/trash/:type/:id/restore
export const restoreTrashItem = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const type = parseType(req.params.type);
    if (!type) {
      res.status(400).json({ success: false, message: "type must be form or response" });
      return;
    }
    const restored = await restoreItem(scopeOf(req), type, String(req.params.id));
    res.status(200).json({ success: true, ...restored });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/trash/:type/:id   body: { confirm: "DELETE" }
export const purgeTrashItem = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const type = parseType(req.params.type);
    if (!type) {
      res.status(400).json({ success: false, message: "type must be form or response" });
      return;
    }
    if (!requireConfirm(req, res)) return;
    await purgeItem(scopeOf(req), type, String(req.params.id));
    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/trash   body: { confirm: "DELETE" }
export const emptyTrashHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!requireConfirm(req, res)) return;
    const removed = await emptyTrash(scopeOf(req));
    res.status(200).json({ success: true, ...removed });
  } catch (error) {
    next(error);
  }
};
