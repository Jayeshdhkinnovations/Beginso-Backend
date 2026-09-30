import { Request, Response, NextFunction } from "express";
import { recordEvent } from "../services/event.service";
import { ZodError } from "zod";
import { ResponseService } from "../services/response.service";
import { ReadStateService } from "../services/readState.service";
import { updateResponseStatusSchema, updateResponseAssigneeSchema } from "../validations/response.validator";
import mongoose from "mongoose";
import { getVerifiedWorkspaceId } from "../utils/requestContext";
import FormAccessGrant from "../models/FormAccessGrant";
import ResponseModel from "../models/Response";
import Notification from "../models/Notification";
import { ActivityService } from "../services/activity.service";

const responseService = new ResponseService();
const readStateService = new ReadStateService();
const activityService = new ActivityService();

export const getResponses = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" },
      });
      return;
    }

    const workspaceId = await getVerifiedWorkspaceId(req);
    // Sprint 12 fix (30 Sep 2026): mirrors form.controller.ts's listForms `isExplicitPersonal`
    // handling. `!workspaceId` used to mean "show nothing" here — but it also covers the caller's
    // genuine Personal shell (explicit `x-workspace-slug: personal`), which has real responses of
    // its own (forms with no workspaceId) and must not be served empty OR silently fall back to
    // some other workspace's data.
    const personalUserId =
      authReq.explicitPersonalContext || !workspaceId ? authReq.user._id.toString() : undefined;
    if (!workspaceId && !personalUserId) {
      res.status(200).json({
        success: true,
        data: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      });
      return;
    }

    const { formId, status, stageId, search, page, limit, duplicate } = req.query;

    const result = await responseService.getResponses({
      workspaceId,
      personalUserId,
      formId: formId ? String(formId) : undefined,
      status: status ? String(status) : undefined,
      stageId: stageId ? String(stageId) : undefined,
      search: search ? String(search) : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      callerUserId: authReq.user._id.toString(),
      duplicate: duplicate === "true" || duplicate === "1",
    });

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    if (error.statusCode) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        error: { message: error.message },
      });
      return;
    }
    next(error);
  }
};

export const getResponseStats = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" },
      });
      return;
    }

    const { formId, stageId } = req.query;
    let isGrant = false;
    const workspaceId = await getVerifiedWorkspaceId(req);
    if (formId && mongoose.Types.ObjectId.isValid(String(formId))) {
      const grant = await FormAccessGrant.findOne({ formId: String(formId), userId: authReq.user._id });
      if (grant) {
        isGrant = true;
      }
    }
    // Sprint 12 fix (30 Sep 2026): same personal-shell handling as getResponses above — do not
    // return an all-zero stub for the caller's genuine Personal context.
    const personalUserId =
      authReq.explicitPersonalContext || (!workspaceId && !isGrant) ? authReq.user._id.toString() : undefined;
    if (!workspaceId && !isGrant && !personalUserId) {
      res.status(200).json({
        success: true,
        total: 0,
        unread: 0,
        new: 0,
        in_progress: 0,
        completed: 0,
        byCategory: { new: 0, in_progress: 0, completed: 0 },
        byStage: [],
      });
      return;
    }

    const stats = await responseService.getResponseStats(
      workspaceId || "",
      String(formId || ""),
      isGrant,
      stageId ? String(stageId) : undefined,
      authReq.user._id.toString(),
      personalUserId
    );

    res.status(200).json({
      success: true,
      // Flat, per design.md §11.2's documented contract (frontend reads r.data.total/byStage/
      // byCategory/unread directly, not nested) — `stats` kept alongside for any other consumer
      // that reads the old nested shape, same dual-key convention as tag/stage controllers.
      ...stats,
      stats,
    });
  } catch (error: any) {
    if (error.statusCode) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        error: { message: error.message },
      });
      return;
    }
    next(error);
  }
};

export const getResponseDetail = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" },
      });
      return;
    }

    const { id } = req.params;
    let isGrant = !!authReq.formAccessGrant;
    if (!isGrant) {
      const resp = await ResponseModel.findById(id).select("formId").lean();
      if (resp && resp.formId) {
        const grant = await FormAccessGrant.findOne({ formId: resp.formId, userId: authReq.user._id });
        if (grant) isGrant = true;
      }
    }
    const workspaceId = await getVerifiedWorkspaceId(req);

    const host = req.get("host") || "localhost";
    const protocol = req.protocol || "http";

    const response = await responseService.getResponseDetail(
      workspaceId || "",
      String(id),
      host,
      protocol,
      isGrant,
      authReq.user._id.toString()
    );

    res.status(200).json({
      success: true,
      response,
    });
  } catch (error: any) {
    if (error.statusCode) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        error: { message: error.message },
      });
      return;
    }
    next(error);
  }
};

export const updateResponseStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" },
      });
      return;
    }

    const workspaceId = await getVerifiedWorkspaceId(req);
    const { id } = req.params;

    let updatedResponse: any = null;

    // assigneeId (B3.2/R4) is independent of status/stageId — either or both may be present in
    // the same PATCH body.
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "assigneeId")) {
      const assigneeParsed = updateResponseAssigneeSchema.parse({ assigneeId: req.body.assigneeId });
      const { response: assignedResponse, previousAssigneeId } = await responseService.updateResponseAssignee(
        workspaceId,
        String(id),
        assigneeParsed.assigneeId
      );
      updatedResponse = assignedResponse;

      await recordEvent(
        req,
        workspaceId,
        "response.assign",
        { id: String(id), type: "response", label: String(id) },
        { fromAssigneeId: previousAssigneeId, toAssigneeId: assigneeParsed.assigneeId }
      );

      // Self-assignment writes no notification.
      const actorId = authReq.user._id.toString();
      if (assigneeParsed.assigneeId && assigneeParsed.assigneeId !== actorId && workspaceId) {
        await Notification.create({
          userId: assigneeParsed.assigneeId,
          workspaceId,
          type: "assignment",
          title: "Response assigned to you",
          message: `${authReq.user.fullName || authReq.user.email} assigned a response to you`,
        }).catch(() => undefined);
      }
    }

    if (req.body?.status !== undefined || req.body?.stageId !== undefined) {
      const parsed = updateResponseStatusSchema.parse({
        status: req.body?.status,
        stageId: req.body?.stageId,
      });

      const { response: stageResponse, fromStageId, toStageId } = await responseService.updateResponseStage(
        workspaceId,
        String(id),
        parsed
      );
      updatedResponse = stageResponse;

      // Kept as "response.status_change" (not "response.stage_change") so the existing audit-log
      // consumer/contract for this endpoint is unchanged; metadata now also carries stage ids.
      await recordEvent(
        req,
        workspaceId,
        "response.status_change",
        { id: String(id), type: "response", label: String(id) },
        { status: stageResponse.status, fromStageId, toStageId }
      );
    }

    if (!updatedResponse) {
      // Neither status/stageId nor assigneeId was sent: same "at least one field" contract as before.
      updateResponseStatusSchema.parse({ status: undefined, stageId: undefined });
    }

    res.status(200).json({
      success: true,
      message: "Response updated successfully",
      response: updatedResponse,
      data: updatedResponse,
    });
  } catch (error: any) {
    if (error instanceof ZodError) {
      res.status(422).json({
        success: false,
        message: "Validation failed",
        errors: error.issues.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
        error: { message: "Validation failed" },
      });
      return;
    }
    if (error.statusCode) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        error: { message: error.message },
      });
      return;
    }
    next(error);
  }
};

export const deleteResponse = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" },
      });
      return;
    }

    const workspaceId = await getVerifiedWorkspaceId(req);
    const { id } = req.params;

    await responseService.deleteResponse(workspaceId, String(id));
    await recordEvent(req, workspaceId, "response.delete", { id: String(id), type: "response", label: String(id) });

    // Return HTTP 204 No Content on successful deletion
    res.status(204).send();
  } catch (error: any) {
    if (error.statusCode) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        error: { message: error.message },
      });
      return;
    }
    next(error);
  }
};

export const getResponseFileUrl = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" },
      });
      return;
    }

    const { id, fileId } = req.params;
    let isGrant = !!authReq.formAccessGrant;
    if (!isGrant) {
      const resp = await ResponseModel.findById(id).select("formId").lean();
      if (resp && resp.formId) {
        const grant = await FormAccessGrant.findOne({ formId: resp.formId, userId: authReq.user._id });
        if (grant) isGrant = true;
      }
    }
    const workspaceId = await getVerifiedWorkspaceId(req);

    const host = req.get("host") || "localhost";
    const protocol = req.protocol || "http";

    const result = await responseService.getResponseFileUrl(
      workspaceId || "",
      String(id),
      String(fileId),
      host,
      protocol,
      isGrant
    );

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    if (error.statusCode) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        error: { message: error.message },
      });
      return;
    }
    next(error);
  }
};

// POST /api/responses/:id/read — idempotent. Marking read never happens on a GET; this is a
// dedicated write endpoint (B8.2).
export const markResponseRead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized", error: { message: "Not authorized" } });
      return;
    }
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      res.status(404).json({ success: false, message: "Response not found", error: { message: "Response not found" } });
      return;
    }
    await readStateService.markRead(authReq.user._id.toString(), String(id));
    res.status(200).json({ success: true, message: "Marked as read", unread: false });
  } catch (error: any) {
    next(error);
  }
};

// GET /api/responses/:id/activity — reads the existing events/audit table (C3.6). Newest last
// (chronological). No raw IP anywhere in the output (activityService never surfaces `ip`).
export const getResponseActivity = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized", error: { message: "Not authorized" } });
      return;
    }
    const { id } = req.params;
    const workspaceId = await getVerifiedWorkspaceId(req);
    const activity = await activityService.forResponse(String(id), workspaceId || null);
    res.status(200).json({ success: true, activity, data: activity });
  } catch (error: any) {
    if (error.statusCode) {
      res.status(error.statusCode).json({ success: false, message: error.message, error: { message: error.message } });
      return;
    }
    next(error);
  }
};

// POST /api/responses/:id/unread — idempotent (a delete of any existing read row).
export const markResponseUnread = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized", error: { message: "Not authorized" } });
      return;
    }
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      res.status(404).json({ success: false, message: "Response not found", error: { message: "Response not found" } });
      return;
    }
    await readStateService.markUnread(authReq.user._id.toString(), String(id));
    res.status(200).json({ success: true, message: "Marked as unread", unread: true });
  } catch (error: any) {
    next(error);
  }
};
