import { ResponseRepository } from "../repositories/response.repository";
import { FormRepository } from "../repositories/form.repository";
import Upload from "../models/Upload";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { getUploadDir, deleteFileAndEmptyParents } from "../controllers/upload.controller";
import { PaginatedResponsesResult, IResponse, IResponseFile } from "../types/response.types";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";

const cleanAnswers = (answers: Record<string, any>): Record<string, any> => {
  if (!answers || typeof answers !== "object") return {};
  const cleaned: Record<string, any> = {};
  const idPattern = /^[0-9a-fA-F]{24}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$|^f_[a-zA-Z0-9_-]+$/;
  for (const [key, val] of Object.entries(answers)) {
    // Keep human-readable label keys and exclude raw ObjectIds, UUIDs, and fieldId patterns
    if (!idPattern.test(key)) {
      cleaned[key] = val;
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : answers;
};

export class ResponseService {
  private responseRepository = new ResponseRepository();
  private formRepository = new FormRepository();

  async getResponses(params: {
    workspaceId: string;
    formId?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResponsesResult> {
    const { workspaceId, formId, status, search } = params;

    let page = Number(params.page) || 1;
    if (page < 1) page = 1;

    let limit = Number(params.limit) || 10;
    if (limit < 1) limit = 10;
    if (limit > 50) limit = 50; // Cap at 50 per page max

    const mongoQuery: any = {};

    // Scope to workspaceId via form lookup
    if (formId) {
      if (!mongoose.Types.ObjectId.isValid(formId)) {
        const err: any = new Error("Form not found");
        err.statusCode = 404;
        throw err;
      }

      const form = await this.formRepository.findById(formId);
      if (!form) {
        const err: any = new Error("Form not found");
        err.statusCode = 404;
        throw err;
      }

      if (!form.workspaceId || form.workspaceId.toString() !== workspaceId) {
        const err: any = new Error("Forbidden: You do not own this form's workspace");
        err.statusCode = 403;
        throw err;
      }

      mongoQuery.formId = form._id;
    } else {
      // Find all forms in workspace
      const forms = await this.formRepository.findWithPagination(
        { workspaceId },
        0,
        1000,
        workspaceId
      );
      const formIds = forms.map((f) => f._id);
      mongoQuery.formId = { $in: formIds };
    }

    // Status filter
    if (status) {
      mongoQuery.status = status;
    }

    // Search filter against answers content
    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(search.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"), "i");
      const candidates = await this.responseRepository.findWithPagination(mongoQuery, 0, 10000);
      const matchingIds = candidates
        .filter((r) => {
          const str = JSON.stringify(r.answers || {});
          return searchRegex.test(str);
        })
        .map((r) => r._id);

      mongoQuery._id = { $in: matchingIds };
    }

    const skip = (page - 1) * limit;

    const [responses, total] = await Promise.all([
      this.responseRepository.findWithPagination(mongoQuery, skip, limit),
      this.responseRepository.count(mongoQuery),
    ]);

    const totalPages = Math.ceil(total / limit);

    // Format output matching IResponse interface
    const formattedData: IResponse[] = responses.map((r: any) => ({
      _id: r._id.toString(),
      formId: r.formId.toString(),
      answers: cleanAnswers(r.answers),
      status: r.status || "new",
      submittedAt: r.submittedAt,
      ipHash: r.ipHash,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    return {
      data: formattedData,
      total,
      page,
      limit,
      totalPages,
    };
  }

  async getResponseStats(
    workspaceId: string,
    formId?: string
  ): Promise<{ total: number; new: number; in_progress: number; completed: number }> {
    if (formId && formId.trim() !== "") {
      if (!mongoose.Types.ObjectId.isValid(formId)) {
        const err: any = new Error("Form not found");
        err.statusCode = 404;
        throw err;
      }

      const form = await this.formRepository.findById(formId);
      if (!form) {
        const err: any = new Error("Form not found");
        err.statusCode = 404;
        throw err;
      }

      if (!form.workspaceId || form.workspaceId.toString() !== workspaceId) {
        const err: any = new Error("Forbidden: You do not own this form's workspace");
        err.statusCode = 403;
        throw err;
      }

      return await this.responseRepository.getStatsByFormId(form._id as mongoose.Types.ObjectId);
    }

    // Workspace-wide stats across all forms in workspace
    const forms = await this.formRepository.findWithPagination(
      { workspaceId },
      0,
      10000,
      workspaceId
    );
    const formIds = forms.map((f) => f._id);

    const statsArr = await ResponseModel.aggregate([
      { $match: { formId: { $in: formIds } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    let newCount = 0;
    let inProgressCount = 0;
    let completedCount = 0;

    for (const item of statsArr) {
      if (item._id === "new") newCount = item.count;
      else if (item._id === "in_progress") inProgressCount = item.count;
      else if (item._id === "completed") completedCount = item.count;
    }

    return {
      total: newCount + inProgressCount + completedCount,
      new: newCount,
      in_progress: inProgressCount,
      completed: completedCount,
    };
  }

  async getResponseDetail(
    workspaceId: string,
    responseId: string,
    host: string,
    protocol: string
  ): Promise<IResponse> {
    const response = await this.responseRepository.findById(responseId);
    if (!response) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    const form = await this.formRepository.findById(response.formId.toString());
    if (!form || !form.workspaceId || form.workspaceId.toString() !== workspaceId) {
      const err: any = new Error("Forbidden: You do not own this response's workspace");
      err.statusCode = 403;
      throw err;
    }

    // Join response_files metadata from Upload collection
    const uploadDocs = await Upload.find({
      path: { $regex: responseId },
    });

    const responseFiles: IResponseFile[] = uploadDocs.map((up) => ({
      id: up._id.toString(),
      name: up.name,
      size: up.size,
      type: up.type,
      url: `${protocol}://${host}/api/upload/file/${up.path.replace(/\\/g, "/")}`,
      uploadTime: up.uploadTime,
    }));

    return {
      _id: response._id.toString(),
      formId: response.formId.toString(),
      answers: cleanAnswers(response.answers),
      status: response.status || "new",
      submittedAt: response.submittedAt,
      ipHash: response.ipHash,
      response_files: responseFiles,
      createdAt: response.createdAt,
      updatedAt: response.updatedAt,
    };
  }

  async updateResponseStatus(
    workspaceId: string,
    responseId: string,
    status: "new" | "in_progress" | "completed"
  ): Promise<IResponse> {
    if (!mongoose.Types.ObjectId.isValid(responseId)) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    const existingResponse = await this.responseRepository.findById(responseId);
    if (!existingResponse) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    const ownedForm = await Form.exists({
      _id: existingResponse.formId,
      workspaceId: workspaceId,
    });

    if (!ownedForm) {
      const err: any = new Error("Forbidden: You do not own this response's workspace");
      err.statusCode = 403;
      throw err;
    }

    const updated = await this.responseRepository.updateStatus(responseId, status);
    if (!updated) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    return {
      _id: updated._id.toString(),
      formId: updated.formId.toString(),
      answers: updated.answers,
      status: updated.status || status,
      submittedAt: updated.submittedAt,
      ipHash: updated.ipHash,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async deleteResponse(workspaceId: string, responseId: string): Promise<boolean> {
    const response = await this.responseRepository.findById(responseId);
    if (!response) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    const form = await this.formRepository.findById(response.formId.toString());
    if (!form || !form.workspaceId || form.workspaceId.toString() !== workspaceId) {
      const err: any = new Error("Forbidden: You do not own this response's workspace");
      err.statusCode = 403;
      throw err;
    }

    // Cascade delete response_files metadata & physical files from disk
    const uploadDocs = await Upload.find({
      path: { $regex: responseId },
    });

    const uploadDir = getUploadDir();
    for (const up of uploadDocs) {
      if (up.path) {
        const fullPath = path.isAbsolute(up.path)
          ? up.path
          : path.join(uploadDir, up.path);
        try {
          if (fs.existsSync(fullPath)) {
            await deleteFileAndEmptyParents(fullPath, uploadDir);
          }
        } catch (fileErr) {
          console.error(`Failed to delete physical file: ${fullPath}`, fileErr);
        }
      }
    }

    // Sweep response directory if present
    try {
      const responseDir = path.join(
        uploadDir,
        form.workspaceId ? form.workspaceId.toString() : "personal",
        form._id.toString(),
        "responses",
        responseId
      );
      if (fs.existsSync(responseDir)) {
        fs.rmSync(responseDir, { recursive: true, force: true });
      }
    } catch (dirErr) {
      // Silently ignore directory sweep errors
    }

    await Upload.deleteMany({ path: { $regex: responseId } });
    await this.responseRepository.deleteById(responseId);

    return true;
  }

  async getResponseFileUrl(
    workspaceId: string,
    responseId: string,
    fileId: string,
    host: string,
    protocol: string,
    sessionToken?: string
  ): Promise<{ url: string }> {
    const response = await this.responseRepository.findById(responseId);
    if (!response) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    const form = await this.formRepository.findById(response.formId.toString());
    if (!form || !form.workspaceId || form.workspaceId.toString() !== workspaceId) {
      const err: any = new Error("Forbidden: You do not own this response's workspace");
      err.statusCode = 403;
      throw err;
    }

    if (!mongoose.Types.ObjectId.isValid(fileId)) {
      const err: any = new Error("File not found for this response");
      err.statusCode = 404;
      throw err;
    }

    const upload = await Upload.findById(fileId);
    if (!upload || !upload.path.includes(responseId)) {
      const err: any = new Error("File not found for this response");
      err.statusCode = 404;
      throw err;
    }

    let safeUrl = `${protocol}://${host}/api/upload/file/${upload.path.replace(/\\/g, "/")}`;
    if (sessionToken) {
      safeUrl += `?token=${encodeURIComponent(sessionToken)}`;
    }

    return { url: safeUrl };
  }
}
