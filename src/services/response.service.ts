import { ResponseRepository } from "../repositories/response.repository";
import { deleteResponseFiles } from "./cleanup.service";
import { FormRepository } from "../repositories/form.repository";
import Upload from "../models/Upload";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import StageModel, { IStage } from "../models/Stage";
import Membership from "../models/Membership";
import FormAccessGrant from "../models/FormAccessGrant";
import { StageService } from "./stage.service";
import { ReadStateService } from "./readState.service";
import { getUploadDir, deleteFileAndEmptyParents } from "../controllers/upload.controller";
import { PaginatedResponsesResult, IResponse, IResponseFile, IResponseStageSummary } from "../types/response.types";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { escapeRegex } from "../utils/safeInput";

const toStageSummary = (stage: IStage | null | undefined): IResponseStageSummary | null => {
  if (!stage) return null;
  return {
    id: stage._id.toString(),
    name: stage.name,
    colour: stage.colour,
    category: stage.category,
    order: stage.order,
  };
};

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
  private stageService = new StageService();
  private readStateService = new ReadStateService();

  async getResponses(params: {
    workspaceId: string;
    formId?: string;
    status?: string;
    stageId?: string;
    search?: string;
    page?: number;
    limit?: number;
    // Whose unread state to join in (the calling user). Omitted only by callers that don't need it.
    callerUserId?: string;
  }): Promise<PaginatedResponsesResult> {
    const { workspaceId, formId, status, stageId, search } = params;

    let page = Number(params.page) || 1;
    if (page < 1) page = 1;

    let limit = Number(params.limit) || 10;
    if (limit < 1) limit = 10;
    if (limit > 50) limit = 50; // Cap at 50 per page max

    const mongoQuery: any = { deletedAt: null };

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

    // Status filter (legacy; still correct because status is kept in sync with stage.category)
    if (status) {
      mongoQuery.status = status;
    }

    // Stage filter (Sprint 12): takes precedence when both are sent since it is the primary key.
    if (stageId) {
      if (!mongoose.Types.ObjectId.isValid(stageId)) {
        const err: any = new Error("Invalid stageId parameter");
        err.statusCode = 400;
        throw err;
      }
      mongoQuery.stageId = new mongoose.Types.ObjectId(stageId);
    }

    // Search filter against answers content
    if (search && search.trim() !== "") {
      const needle = search.trim().toLowerCase();
      const searchRegex = new RegExp(escapeRegex(needle), "i");

      // Responses that have a stored searchText are matched inside MongoDB. Only responses stored
      // before searchText existed (until the backfill script has run) still fall back to the old
      // in-memory scan, capped as before.
      const legacy = await this.responseRepository.findWithPagination(
        { ...mongoQuery, searchText: { $exists: false } },
        0,
        10000
      );
      const legacyIds = legacy
        .filter((r) => searchRegex.test(JSON.stringify(r.answers || {})))
        .map((r) => r._id);

      mongoQuery.$or = [{ searchText: searchRegex }, { _id: { $in: legacyIds } }];
    }

    const skip = (page - 1) * limit;

    const [responses, total] = await Promise.all([
      this.responseRepository.findWithPagination(mongoQuery, skip, limit),
      this.responseRepository.count(mongoQuery),
    ]);

    const totalPages = Math.ceil(total / limit);

    // Batch-fetch stages referenced by this page rather than populating per-response.
    const stageIds = [...new Set(responses.filter((r: any) => r.stageId).map((r: any) => r.stageId.toString()))];
    const stagesById = new Map<string, IStage>(
      stageIds.length
        ? (await StageModel.find({ _id: { $in: stageIds } })).map((s) => [s._id.toString(), s])
        : []
    );

    // Batched unread join for the calling user, one query for the whole page (B8.2) — never N+1.
    const unreadMap = params.callerUserId
      ? await this.readStateService.unreadMap(params.callerUserId, responses.map((r: any) => r._id))
      : null;

    // Format output matching IResponse interface
    const formattedData: IResponse[] = responses.map((r: any) => ({
      _id: r._id.toString(),
      formId: r.formId.toString(),
      answers: cleanAnswers(r.answers),
      stageId: r.stageId ? r.stageId.toString() : undefined,
      stage: r.stageId ? toStageSummary(stagesById.get(r.stageId.toString())) : null,
      status: r.status || "new",
      submittedAt: r.submittedAt,
      ipHash: r.ipHash,
      tagIds: (r.tagIds || []).map((t: any) => t.toString()),
      assigneeId: r.assigneeId ? r.assigneeId.toString() : null,
      unread: unreadMap ? unreadMap.get(r._id.toString()) ?? true : undefined,
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

  // Joins raw {stageId,count} pairs against the workspace's stages for name/colour/category.
  // Responses with no stageId yet (pre-migration) are omitted, same as an unset $group key.
  private async buildStageBreakdown(
    workspaceId: string,
    matchQuery: any
  ): Promise<Array<{ stageId: string; name: string; colour: string; category: string; count: number }>> {
    const [counts, stages] = await Promise.all([
      this.responseRepository.getStageCounts(matchQuery),
      this.stageService.listStages(workspaceId),
    ]);
    const stagesById = new Map(stages.map((s) => [s._id.toString(), s]));
    return counts
      .filter((c) => c._id)
      .map((c) => {
        const stage = stagesById.get(c._id!.toString());
        return {
          stageId: c._id!.toString(),
          name: stage?.name || "Unknown stage",
          colour: stage?.colour || "slate",
          category: stage?.category || "new",
          count: c.count,
        };
      });
  }

  // Sprint 12 (BE 0.1/0.2), design.md §11.2 `GET /api/responses/stats`: the documented V2
  // contract is flat `{total, unread, byStage, byCategory}`. This method used to return only the
  // pre-Sprint-12 shape (`new`/`in_progress`/`completed`/`stageBreakdown`) — a real bug, not just
  // a naming mismatch: the frontend reads `byCategory`/`byStage`/`unread`, none of which existed
  // here, so every stat card silently read as 0 regardless of actual data. Legacy
  // `new`/`in_progress`/`completed` keys are kept as aliases during the deprecation window
  // (design.md's own note), `byCategory ` is the V2-primary field.
  async getResponseStats(
    workspaceId: string,
    formId?: string,
    isGrant?: boolean,
    stageId?: string,
    callerUserId?: string
  ): Promise<{
    total: number;
    unread: number;
    new: number;
    in_progress: number;
    completed: number;
    byCategory: { new: number; in_progress: number; completed: number };
    byStage: Array<{ stageId: string; name: string; colour: string; category: string; count: number }>;
    /** @deprecated alias for byStage, kept for any caller still on the pre-Sprint-12 field name */
    stageBreakdown: Array<{ stageId: string; name: string; colour: string; category: string; count: number }>;
  }> {
    let statusMatch: any;
    let scopeWorkspaceId: string;

    if (formId) {
      if (!mongoose.Types.ObjectId.isValid(formId)) {
        const err: any = new Error("Invalid formId parameter");
        err.statusCode = 400;
        throw err;
      }

      const form = await this.formRepository.findById(formId);
      if (!form) {
        const err: any = new Error("Form not found");
        err.statusCode = 404;
        throw err;
      }

      if (!isGrant && (!form.workspaceId || form.workspaceId.toString() !== workspaceId)) {
        const err: any = new Error("Forbidden: You do not own this form's workspace");
        err.statusCode = 403;
        throw err;
      }

      statusMatch = { formId: form._id, deletedAt: null };
      scopeWorkspaceId = workspaceId || form.workspaceId!.toString();
    } else {
      // Workspace-wide stats across all forms in workspace
      const forms = await this.formRepository.findWithPagination(
        { workspaceId },
        0,
        10000,
        workspaceId
      );
      const formIds = forms.map((f) => f._id);

      statusMatch = { formId: { $in: formIds }, deletedAt: null };
      if (stageId && mongoose.Types.ObjectId.isValid(stageId)) {
        statusMatch.stageId = new mongoose.Types.ObjectId(stageId);
      }
      scopeWorkspaceId = workspaceId;
    }

    const [statsArr, byStage, unread] = await Promise.all([
      ResponseModel.aggregate([{ $match: statusMatch }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      this.buildStageBreakdown(scopeWorkspaceId, statusMatch),
      callerUserId ? this.readStateService.countUnread(callerUserId, statusMatch) : Promise.resolve(0),
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
      unread,
      new: newCount,
      in_progress: inProgressCount,
      completed: completedCount,
      byCategory: { new: newCount, in_progress: inProgressCount, completed: completedCount },
      byStage,
      stageBreakdown: byStage,
    };
  }

  async getResponseDetail(
    workspaceId: string,
    responseId: string,
    host: string,
    protocol: string,
    isGrant?: boolean,
    callerUserId?: string
  ): Promise<IResponse> {
    const response = await this.responseRepository.findById(responseId);
    if (!response || response.deletedAt) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    const form = await this.formRepository.findById(response.formId.toString());
    if (!isGrant && (!form || !form.workspaceId || form.workspaceId.toString() !== workspaceId)) {
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

    const stage = response.stageId ? await StageModel.findById(response.stageId) : null;

    return {
      _id: response._id.toString(),
      formId: response.formId.toString(),
      answers: cleanAnswers(response.answers),
      stageId: response.stageId ? response.stageId.toString() : undefined,
      stage: toStageSummary(stage),
      status: response.status || "new",
      submittedAt: response.submittedAt,
      ipHash: response.ipHash,
      response_files: responseFiles,
      tagIds: (response.tagIds || []).map((t) => t.toString()),
      assigneeId: response.assigneeId ? response.assigneeId.toString() : null,
      unread: callerUserId ? await this.readStateService.isUnread(callerUserId, responseId) : undefined,
      createdAt: response.createdAt,
      updatedAt: response.updatedAt,
    };
  }

  // Moves a response onto a stage (Sprint 12) or, for callers not yet migrated, onto whichever
  // stage matches the legacy status value's category. Either way stageId and the derived status
  // land in the same write, so both keep reading correct regardless of which one the caller used.
  // Returns the previous stageId alongside the updated response so the caller can log an event.
  async updateResponseStage(
    workspaceId: string,
    responseId: string,
    input: { status?: "new" | "in_progress" | "completed"; stageId?: string }
  ): Promise<{ response: IResponse; fromStageId: string | null; toStageId: string }> {
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

    // stageId is the primary key; status is resolved to a matching stage when stageId is absent.
    const targetStage = input.stageId
      ? await this.stageService.getStageInWorkspace(workspaceId, input.stageId)
      : await this.stageService.resolveStageForCategory(workspaceId, input.status!);

    const fromStageId = existingResponse.stageId ? existingResponse.stageId.toString() : null;

    const updated = await this.responseRepository.updateStage(
      responseId,
      targetStage._id as mongoose.Types.ObjectId,
      targetStage.category
    );
    if (!updated) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    return {
      response: {
        _id: updated._id.toString(),
        formId: updated.formId.toString(),
        answers: updated.answers,
        stageId: updated.stageId!.toString(),
        stage: toStageSummary(targetStage),
        status: updated.status || targetStage.category,
        submittedAt: updated.submittedAt,
        ipHash: updated.ipHash,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
      fromStageId,
      toStageId: targetStage._id.toString(),
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

    await deleteResponseFiles(responseId, form._id.toString());
    await this.responseRepository.deleteById(responseId);

    return true;
  }

  async getResponseFileUrl(
    workspaceId: string,
    responseId: string,
    fileId: string,
    host: string,
    protocol: string,
    isGrant?: boolean
  ): Promise<{ url: string }> {
    const response = await this.responseRepository.findById(responseId);
    if (!response) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    const form = await this.formRepository.findById(response.formId.toString());
    if (!isGrant && (!form || !form.workspaceId || form.workspaceId.toString() !== workspaceId)) {
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

    // No credential in the URL: the caller authenticates the download with its own session.
    return { url: `${protocol}://${host}/api/upload/file/${upload.path.replace(/\\/g, "/")}` };
  }

  // Sprint 12, BE 0.2 (B3.2/R4). assigneeId is validated independently of stageId/status so a
  // PATCH can change either or both. null unassigns. Returns the previous assigneeId so the
  // caller can log an event and skip the self-assignment notification.
  async updateResponseAssignee(
    workspaceId: string,
    responseId: string,
    assigneeId: string | null
  ): Promise<{ response: IResponse; previousAssigneeId: string | null }> {
    if (!mongoose.Types.ObjectId.isValid(responseId)) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }
    const existing = await this.responseRepository.findById(responseId);
    if (!existing || existing.deletedAt) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }
    const form = await this.formRepository.findById(existing.formId.toString());
    if (!form || !form.workspaceId || form.workspaceId.toString() !== workspaceId) {
      const err: any = new Error("Forbidden: You do not own this response's workspace");
      err.statusCode = 403;
      throw err;
    }

    if (assigneeId !== null) {
      const hasAccess = await this.userHasAccessToForm(assigneeId, form._id.toString(), workspaceId);
      if (!hasAccess) {
        const err: any = new Error("assigneeId must be a current member with access to this response's form");
        err.statusCode = 422;
        err.code = "INVALID_ASSIGNEE";
        throw err;
      }
    }

    const previousAssigneeId = existing.assigneeId ? existing.assigneeId.toString() : null;
    const updated = await ResponseModel.findByIdAndUpdate(
      responseId,
      { $set: { assigneeId: assigneeId ? new mongoose.Types.ObjectId(assigneeId) : null } },
      { new: true }
    );
    if (!updated) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    return {
      response: {
        _id: updated._id.toString(),
        formId: updated.formId.toString(),
        answers: updated.answers,
        assigneeId: updated.assigneeId ? updated.assigneeId.toString() : null,
        status: updated.status,
        stageId: updated.stageId ? updated.stageId.toString() : undefined,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
      previousAssigneeId,
    };
  }

  // A "current member with access to the response's form": either a workspace membership of the
  // form's own workspace, or a per-form access grant.
  async userHasAccessToForm(userId: string, formId: string, workspaceId: string | null): Promise<boolean> {
    if (!mongoose.Types.ObjectId.isValid(userId)) return false;
    if (workspaceId) {
      const membership = await Membership.findOne({ userId, workspaceId }).lean();
      if (membership) return true;
    }
    const grant = await FormAccessGrant.findOne({ userId, formId }).lean();
    return !!grant;
  }

  // Soft delete (B2.2 / OQ-3). Exposed only via the bulk endpoint's `delete`/`restore` actions —
  // the pre-existing single-item DELETE /api/responses/:id stays a hard cascade delete (its
  // contract, including physical file removal, is already tested and unchanged by this sprint).
  async softDeleteResponse(responseId: string): Promise<{ wasAlreadyDeleted: boolean }> {
    const existing = await ResponseModel.findById(responseId).select("deletedAt").lean();
    if (!existing) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }
    const wasAlreadyDeleted = !!existing.deletedAt;
    if (!wasAlreadyDeleted) {
      await ResponseModel.updateOne({ _id: responseId }, { $set: { deletedAt: new Date() } });
    }
    return { wasAlreadyDeleted };
  }

  async restoreResponse(responseId: string): Promise<{ wasDeleted: boolean }> {
    const existing = await ResponseModel.findById(responseId).select("deletedAt").lean();
    if (!existing) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }
    const wasDeleted = !!existing.deletedAt;
    if (wasDeleted) {
      await ResponseModel.updateOne({ _id: responseId }, { $set: { deletedAt: null } });
    }
    return { wasDeleted };
  }
}
