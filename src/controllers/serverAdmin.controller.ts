import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import * as server from "../services/serverAdmin.service";
import type { Actor } from "../services/superadminOps.service";
import { logsQuerySchema } from "../validations/serverAdmin.validator";
import { zodMessage } from "../validations/adminContent.validator";

// Thin HTTP layer for the super admin Server page (see the comments in serverAdmin.service.ts). Read-only. Answers are never stored by
// the browser or a proxy. Errors carrying a statusCode (404, 502) are answered with a fixed message; anything else goes to the global handler.

const actorOf = (req: Request): Actor => {
  const u = (req as any).user;
  return { id: u._id.toString(), email: u.email, fullName: u.fullName };
};

const handle =
  (run: (req: Request) => Promise<object>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    res.set("Cache-Control", "no-store");
    try {
      res.json({ success: true, ...(await run(req)) });
    } catch (error: any) {
      if (error instanceof ZodError) {
        res.status(422).json({ success: false, message: zodMessage(error) });
      } else if (error?.statusCode === 404 || error?.statusCode === 502) {
        res.status(error.statusCode).json({ success: false, message: error.message });
      } else {
        next(error);
      }
    }
  };

export const getContainers = handle(() => server.listContainers());
export const getContainerLogs = handle((req) => server.getContainerLogs(actorOf(req), String(req.params.name), logsQuerySchema.parse(req.query)));
export const getServerHealth = handle(() => server.getServerHealth());
