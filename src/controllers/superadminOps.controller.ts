import { Request, Response, NextFunction } from "express";
import * as ops from "../services/superadminOps.service";

// Thin HTTP layer for the operator-console surfaces in superadminOps.service.ts. Errors carrying a statusCode
// (404, 422) are answered here; everything else goes to the global handler.

const actorOf = (req: Request): ops.Actor => {
  const u = (req as any).user;
  return { id: u._id.toString(), email: u.email, fullName: u.fullName };
};

const num = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v) || undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const handle =
  (run: (req: Request) => Promise<object>, ok = 200) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(ok).json({ success: true, ...(await run(req)) });
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.statusCode === 422) {
        res.status(error.statusCode).json({ success: false, message: error.message });
      } else if (error?.name === "ValidationError") {
        res.status(422).json({ success: false, message: error.message });
      } else {
        next(error);
      }
    }
  };

const listQuery = (req: Request) => ({ page: num(req.query.page), limit: num(req.query.limit), search: str(req.query.search) });

export const getStorage = handle((req) => ops.getStorage({ ...listQuery(req), state: str(req.query.state) as ops.StorageState | undefined }));

export const listWorkspaces = handle((req) => ops.listWorkspaces(listQuery(req)));
export const getWorkspace = handle((req) => ops.getWorkspace(String(req.params.id)));
export const deleteWorkspace = handle((req) => ops.deleteWorkspace(actorOf(req), String(req.params.id), req.body?.confirm));

export const listTemplates = handle((req) => ops.listTemplates(listQuery(req)));
export const createTemplate = handle((req) => ops.createTemplate(actorOf(req), req.body), 201);
export const updateTemplate = handle((req) => ops.updateTemplate(actorOf(req), String(req.params.id), req.body));
export const deleteTemplate = handle((req) => ops.deleteTemplate(actorOf(req), String(req.params.id), req.body?.confirm));

export const listUserSessions = handle((req) => ops.listUserSessions(String(req.params.id)));
export const revokeUserSession = handle((req) => ops.revokeUserSession(actorOf(req), String(req.params.id), String(req.params.sessionId)));
export const revokeAllUserSessions = handle((req) => ops.revokeAllUserSessions(actorOf(req), String(req.params.id)));

export const getHealth = handle(() => ops.getHealth());

export const listExports = handle((req) => ops.listExports({ ...listQuery(req), status: str(req.query.status) }));
export const retryExport = handle((req) => ops.retryExport(actorOf(req), String(req.params.id)));
