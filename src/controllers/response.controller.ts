import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { ResponseService } from "../services/response.service";
import { updateResponseStatusSchema } from "../validations/response.validator";
import mongoose from "mongoose";
import { getVerifiedWorkspaceId } from "../utils/requestContext";
import FormAccessGrant from "../models/FormAccessGrant";
import ResponseModel from "../models/Response";

const responseService = new ResponseService();

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
    if (!workspaceId) {
      res.status(200).json({
        success: true,
        responses: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      });
      return;
    }

    const { formId, status, search, page, limit } = req.query;

    const result = await responseService.getResponses({
      workspaceId,
      formId: formId ? String(formId) : undefined,
      status: status ? String(status) : undefined,
      search: search ? String(search) : undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
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

    const { formId } = req.query;
    let isGrant = false;
    let workspaceId = await getVerifiedWorkspaceId(req);
    if (formId && mongoose.Types.ObjectId.isValid(String(formId))) {
      const grant = await FormAccessGrant.findOne({ formId: String(formId), userId: authReq.user._id });
      if (grant) {
        isGrant = true;
      }
    }
    if (!workspaceId && !isGrant) {
      res.status(200).json({
        success: true,
        total: 0,
        new: 0,
        in_progress: 0,
        completed: 0,
      });
      return;
    }

    const stats = await responseService.getResponseStats(
      workspaceId || "",
      String(formId || ""),
      isGrant
    );

    res.status(200).json({
      success: true,
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
      isGrant
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

    const parsed = updateResponseStatusSchema.parse({
      status: req.body?.status,
    });

    const updatedResponse = await responseService.updateResponseStatus(
      workspaceId,
      String(id),
      parsed.status
    );

    res.status(200).json({
      success: true,
      message: "Response status updated successfully",
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

    // Extract caller token for URL appending fallback
    const authHeader = req.headers.authorization || (req.headers as any).Authorization;
    let sessionToken: string | undefined;
    if (authHeader && typeof authHeader === "string") {
      const parts = authHeader.trim().split(" ");
      sessionToken = parts.length === 2 ? parts[1] : parts[0];
    }
    if (!sessionToken && typeof req.query.token === "string") {
      sessionToken = req.query.token;
    }

    const result = await responseService.getResponseFileUrl(
      workspaceId || "",
      String(id),
      String(fileId),
      host,
      protocol,
      sessionToken,
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
