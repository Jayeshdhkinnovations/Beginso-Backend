import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { BulkService } from "../services/bulk.service";
import { bulkRequestSchema } from "../validations/bulk.validator";
import { getVerifiedWorkspaceId } from "../utils/requestContext";
import { hashIp } from "../utils/ip";

const bulkService = new BulkService();

// POST /api/responses/bulk (B2.1). One request instead of N; permission and the filter target are
// both re-evaluated server-side, never trusted from the client.
export const bulkUpdateResponses = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized", error: { message: "Not authorized" } });
      return;
    }

    const parsed = bulkRequestSchema.parse(req.body);
    const callerWorkspaceId = await getVerifiedWorkspaceId(req);
    if (!callerWorkspaceId) {
      res.status(403).json({ success: false, message: "Workspace not found or access denied" });
      return;
    }

    const result = await bulkService.run(parsed.target, parsed.action, {
      callerWorkspaceId,
      callerWorkspaceRole: authReq.workspaceRole || null,
      actor: {
        id: authReq.user._id.toString(),
        email: authReq.user.email,
        name: authReq.user.fullName || authReq.user.email,
      },
      ip: req.ip ? hashIp(req.ip) : undefined,
    });

    res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    if (error instanceof ZodError) {
      res.status(422).json({
        success: false,
        message: "Validation failed",
        errors: error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
        error: { message: "Validation failed" },
      });
      return;
    }
    if (error.statusCode) {
      res.status(error.statusCode).json({ success: false, message: error.message, error: { message: error.message } });
      return;
    }
    next(error);
  }
};
