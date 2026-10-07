import { ResponseRepository } from "../repositories/response.repository";
import { FormRepository } from "../repositories/form.repository";
import Upload from "../models/Upload";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import StageModel, { IStage } from "../models/Stage";
import User, { IUser } from "../models/User";
import TagModel, { ITag } from "../models/Tag";
import { StageService } from "./stage.service";
import { ReadStateService } from "./readState.service";
import { NoteService } from "./note.service";
import { ScoreService } from "./score.service";
import { logWorkspaceEvent } from "./event.service";
import { userHasAccessToForm as userHasAccessToFormShared } from "../utils/formAccess";
import { getUploadDir, deleteFileAndEmptyParents } from "../controllers/upload.controller";
import {
  PaginatedResponsesResult,
  IResponse,
  IResponseFile,
  IResponseStageSummary,
  IResponseAssigneeSummary,
  IResponseTagSummary,
} from "../types/response.types";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { escapeRegex } from "../utils/safeInput";
import { fieldSegmentFilter, SegmentError } from "../utils/fieldSegments";
import { buildResponseFilterQuery } from "../utils/responseFilters";

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

// Bug fix, Sprint 12 close-out: `assigneeId`/`tagIds` were being sent as raw ids only — neither
// `AssigneePicker` nor `TagPicker` on the frontend can render a name/colour from an id alone, so
// the sidebar always looked "stuck" at Unassigned/no-tags regardless of what was actually saved.
const toAssigneeSummary = (user: IUser | null | undefined): IResponseAssigneeSummary | null => {
  if (!user) return null;
  return { id: user._id.toString(), name: user.fullName, avatarUrl: user.avatarUrl ?? null };
};

const toTagSummaries = (tagIds: mongoose.Types.ObjectId[] | undefined, tagsById: Map<string, ITag>): IResponseTagSummary[] =>
  (tagIds || [])
    .map((id) => tagsById.get(id.toString()))
    .filter((t): t is ITag => !!t)
    .map((t) => ({ id: t._id.toString(), name: t.name, colour: t.colour }));

// Bug fix, Sprint 12 close-out: every response-scoped method below independently duplicated
// `!form.workspaceId || form.workspaceId.toString() !== workspaceId` as its ownership check —
// which throws 403 unconditionally the instant a form has no workspace, since `!form.workspaceId`
// alone is `true` regardless of what the caller's own `workspaceId` is. That made EVERY personal
// form's responses inaccessible to their own owner (view detail, delete, assign, tag, download —
// every one of these five call sites had the identical bug). A personal form's real owner check
// is `createdBy`, not `workspaceId` (there is none to compare).
const ownsResponseForm = (form: { workspaceId?: mongoose.Types.ObjectId | null; createdBy?: mongoose.Types.ObjectId | null } | null, workspaceId: string | null, callerUserId?: string): boolean => {
  if (!form) return false;
  return form.workspaceId
    ? form.workspaceId.toString() === workspaceId
    : !!callerUserId && form.createdBy?.toString() === callerUserId;
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
  private noteService = new NoteService();
  private scoreService = new ScoreService();

  async getResponses(params: {
    workspaceId: string;
    // Sprint 12 fix (30 Sep 2026): true Personal-shell listing — forms with no workspaceId,
    // owned by this user. Mirrors formService.listForms's own personalUserId handling.
    personalUserId?: string;
    formId?: string;
    status?: string;
    stageId?: string;
    search?: string;
    page?: number;
    limit?: number;
    // Whose unread state to join in (the calling user). Omitted only by callers that don't need it.
    callerUserId?: string;
    // Sprint 12, BE 0.6 (B4.10): "Show duplicates" filter — true = only flagged responses.
    duplicate?: boolean;
    // Sprint 13 (F15): test submissions are excluded unless the caller opts in.
    includeTest?: boolean;
    // A per-form access grant (verified by requirePermission) opens this one form for a non-owner.
    isGrant?: boolean;
    // Charts v2: segment filter (needs formId) - field=<fieldId>&value=<bucket value>[&granularity=] - plus the
    // filters the Inbox sends that this route used to ignore. See utils/fieldSegments.ts.
    field?: string;
    value?: string;
    granularity?: string;
    tagIds?: string[];
    assigneeId?: string;
    unread?: boolean;
    from?: string;
    to?: string;
  }): Promise<PaginatedResponsesResult> {
    const { workspaceId, personalUserId, formId, status, stageId, search } = params;

    let page = Number(params.page) || 1;
    if (page < 1) page = 1;

    let limit = Number(params.limit) || 10;
    if (limit < 1) limit = 10;
    if (limit > 50) limit = 50; // Cap at 50 per page max

    const mongoQuery: any = { deletedAt: null };
    // Naming `isTest` in the filter is what tells the Response query hook not to apply its default
    // exclusion; matching true, false and absent returns every row.
    if (params.includeTest) mongoQuery.isTest = { $in: [true, false, null] };

    // Scope to workspaceId (or the caller's personal forms) via form lookup
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

      const belongsToWorkspace = !!workspaceId && !!form.workspaceId && form.workspaceId.toString() === workspaceId;
      const belongsToCaller =
        !!personalUserId && !form.workspaceId && String(form.createdBy) === personalUserId;

      if (!params.isGrant && !belongsToWorkspace && !belongsToCaller) {
        const err: any = new Error("Forbidden: You do not own this form's workspace");
        err.statusCode = 403;
        throw err;
      }

      mongoQuery.formId = form._id;
      if (params.field !== undefined || params.value !== undefined) {
        mongoQuery.$and = [fieldSegmentFilter(form, params.field, params.value, params.granularity)];
      }
    } else if (params.field !== undefined || params.value !== undefined) {
      throw new SegmentError(400, "FIELD_FILTER_REQUIRES_FORM", "field/value filtering needs formId (question ids are per form)");
    } else if (personalUserId) {
      // Ids only: loading whole form documents (fields, pages, settings) just to read _id was the cost here.
      const forms = await Form.find({ createdBy: personalUserId, $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }] }).select("_id").lean();
      mongoQuery.formId = { $in: forms.map((f) => f._id) };
    } else {
      // Find all forms in workspace
      const forms = await Form.find({ workspaceId }).select("_id").lean();
      mongoQuery.formId = { $in: forms.map((f) => f._id) };
    }

    // Status filter (legacy; still correct because status is kept in sync with stage.category)
    if (status) {
      mongoQuery.status = status;
    }

    // Stage filter (Sprint 12): takes precedence when both are sent since it is the primary key.
    // The Board view sends a column's category slug (new | in_progress | completed) as `stageId`;
    // that means "every stage in that category", i.e. the legacy status filter, not a stage id.
    if (stageId && ["new", "in_progress", "completed"].includes(stageId)) {
      mongoQuery.status = stageId;
    } else if (stageId) {
      if (!mongoose.Types.ObjectId.isValid(stageId)) {
        const err: any = new Error("Invalid stageId parameter");
        err.statusCode = 400;
        throw err;
      }
      mongoQuery.stageId = new mongoose.Types.ObjectId(stageId);
    }

    // Duplicate filter (Sprint 12, BE 0.6 / B4.10)
    if (params.duplicate) {
      mongoQuery.duplicateOfId = { $ne: null };
    }

    // Tags / assignee / unread / date range: same builder the bulk + export paths use, so the three cannot drift.
    // (Only its non-scope parts are taken; scope and soft-delete are already set above.)
    if (params.tagIds?.length || params.assigneeId || params.unread || params.from || params.to) {
      const ids = mongoQuery.formId?.$in ?? [mongoQuery.formId];
      const f = await buildResponseFilterQuery(
        { tagIds: params.tagIds, assigneeId: params.assigneeId, unread: params.unread, from: params.from, to: params.to },
        ids,
        params.callerUserId
      );
      for (const k of ["tagIds", "assigneeId", "submittedAt", "_id"]) if (f[k] !== undefined) mongoQuery[k] = f[k];
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

    // Bug fix, Sprint 12 close-out (same batched-join pattern as stages above): assignee/tags
    // were never resolved past their raw ids, so the sidebar always showed Unassigned/no tags.
    const assigneeIds = [...new Set(responses.filter((r: any) => r.assigneeId).map((r: any) => r.assigneeId.toString()))];
    const usersById = new Map<string, IUser>(
      assigneeIds.length ? (await User.find({ _id: { $in: assigneeIds } })).map((u) => [u._id.toString(), u]) : []
    );
    const allTagIds = [...new Set(responses.flatMap((r: any) => (r.tagIds || []).map((t: any) => t.toString())))];
    const tagsById = new Map<string, ITag>(
      allTagIds.length ? (await TagModel.find({ _id: { $in: allTagIds } })).map((t) => [t._id.toString(), t]) : []
    );

    // Batched unread join for the calling user, one query for the whole page (B8.2) — never N+1.
    const unreadMap = params.callerUserId
      ? await this.readStateService.unreadMap(params.callerUserId, responses.map((r: any) => r._id))
      : null;

    // Sprint 12, BE 0.3 (B5.x): live note counts for the whole page, one query — same batched-join
    // pattern as the unread map above, never N+1.
    const noteCountMap = await this.noteService.countsFor(responses.map((r: any) => r._id.toString()));

    // Sprint 12, BE 0.5 (B6.1): batched scoreAverage/scoreCount for the whole page, one query —
    // same batched-join pattern as noteCountMap above, so the Inbox list shows scores without an
    // extra per-row call.
    const scoreMap = await this.scoreService.aggregateForMany(responses.map((r: any) => r._id.toString()));

    // Format output matching IResponse interface
    const formattedData: IResponse[] = responses.map((r: any) => ({
      _id: r._id.toString(),
      formId: r.formId.toString(),
      reference: r.reference,
      answers: cleanAnswers(r.answers),
      stageId: r.stageId ? r.stageId.toString() : undefined,
      stage: r.stageId ? toStageSummary(stagesById.get(r.stageId.toString())) : null,
      status: r.status || "new",
      submittedAt: r.submittedAt,
      ipHash: r.ipHash,
      tagIds: (r.tagIds || []).map((t: any) => t.toString()),
      tags: toTagSummaries(r.tagIds, tagsById),
      assigneeId: r.assigneeId ? r.assigneeId.toString() : null,
      assignee: r.assigneeId ? toAssigneeSummary(usersById.get(r.assigneeId.toString())) : null,
      unread: unreadMap ? unreadMap.get(r._id.toString()) ?? true : undefined,
      noteCount: noteCountMap.get(r._id.toString()) ?? 0,
      scoreAverage: scoreMap.get(r._id.toString())?.scoreAverage ?? null,
      scoreCount: scoreMap.get(r._id.toString())?.scoreCount ?? 0,
      duplicateOfId: r.duplicateOfId ? r.duplicateOfId.toString() : null,
      ...(r.isTest ? { isTest: true } : {}),
      editedAfterReviewAt: r.editedAfterReviewAt ?? null,
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
    callerUserId?: string,
    // Sprint 12 fix (30 Sep 2026): true Personal-shell stats, mirrors getResponses above.
    personalUserId?: string
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

      const belongsToWorkspace = !!workspaceId && !!form.workspaceId && form.workspaceId.toString() === workspaceId;
      const belongsToCaller =
        !!personalUserId && !form.workspaceId && String(form.createdBy) === personalUserId;

      if (!isGrant && !belongsToWorkspace && !belongsToCaller) {
        const err: any = new Error("Forbidden: You do not own this form's workspace");
        err.statusCode = 403;
        throw err;
      }

      statusMatch = { formId: form._id, deletedAt: null };
      scopeWorkspaceId = workspaceId || form.workspaceId?.toString() || "";
    } else if (personalUserId) {
      const forms = await Form.find({ createdBy: personalUserId, $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }] }).select("_id").lean();
      statusMatch = { formId: { $in: forms.map((f) => f._id) }, deletedAt: null };
      scopeWorkspaceId = "";
    } else {
      // Workspace-wide stats across all forms in workspace
      const forms = await Form.find({ workspaceId }).select("_id").lean();
      statusMatch = { formId: { $in: forms.map((f) => f._id) }, deletedAt: null };
      if (stageId && mongoose.Types.ObjectId.isValid(stageId)) {
        statusMatch.stageId = new mongoose.Types.ObjectId(stageId);
      }
      scopeWorkspaceId = workspaceId;
    }

    const [statsArr, byStage, unread] = await Promise.all([
      ResponseModel.aggregate([{ $match: statusMatch }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      // Personal-shell forms have no workspace-owned stages (OQ-9: stages fixed to defaults there).
      scopeWorkspaceId ? this.buildStageBreakdown(scopeWorkspaceId, statusMatch) : Promise.resolve([]),
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
    if (!isGrant && !ownsResponseForm(form, workspaceId, callerUserId)) {
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
    const noteCount = await this.noteService.countFor(responseId);
    const scoreAggregate = await this.scoreService.aggregateFor(responseId);
    // Same bug fix as getResponses above — resolve assignee/tags past their raw ids.
    const assigneeUser = response.assigneeId ? await User.findById(response.assigneeId) : null;
    const tagDocs = response.tagIds?.length ? await TagModel.find({ _id: { $in: response.tagIds } }) : [];
    const tagsById = new Map<string, ITag>(tagDocs.map((t) => [t._id.toString(), t]));

    return {
      _id: response._id.toString(),
      formId: response.formId.toString(),
      reference: response.reference,
      answers: cleanAnswers(response.answers),
      stageId: response.stageId ? response.stageId.toString() : undefined,
      stage: toStageSummary(stage),
      status: response.status || "new",
      submittedAt: response.submittedAt,
      ipHash: response.ipHash,
      response_files: responseFiles,
      tagIds: (response.tagIds || []).map((t) => t.toString()),
      tags: toTagSummaries(response.tagIds, tagsById),
      assigneeId: response.assigneeId ? response.assigneeId.toString() : null,
      assignee: toAssigneeSummary(assigneeUser),
      unread: callerUserId ? await this.readStateService.isUnread(callerUserId, responseId) : undefined,
      noteCount,
      scoreAverage: scoreAggregate.scoreAverage,
      scoreCount: scoreAggregate.scoreCount,
      duplicateOfId: response.duplicateOfId ? response.duplicateOfId.toString() : null,
      ...(response.isTest ? { isTest: true } : {}),
      editedAfterReviewAt: response.editedAfterReviewAt ?? null,
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
    input: { status?: "new" | "in_progress" | "completed"; stageId?: string },
    callerUserId?: string
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

    // Same ownership rule as every other response-scoped method (see ownsResponseForm): a workspace
    // form is owned by its workspace, a personal form by its creator. This used to query
    // `Form.exists({ workspaceId })` directly — for a personal form `workspaceId` is "" and Mongoose
    // can't cast that to an ObjectId, so changing the stage of a personal response failed with a
    // CastError ("Invalid identifier", HTTP 400) before the personal branch below was ever reached.
    const ownedForm = await this.formRepository.findById(existingResponse.formId.toString());

    if (!ownedForm || !ownsResponseForm(ownedForm, workspaceId, callerUserId)) {
      const err: any = new Error("Forbidden: You do not own this response's workspace");
      err.statusCode = 403;
      throw err;
    }

    // Bug fix, Sprint 12 close-out (OQ-9 "fixed default stages" for the personal shell): a
    // personal response has no workspace, so it can never have a real Stage document — `Stage.
    // workspaceId` is a required field, and `new mongoose.Types.ObjectId(null)` (what the old
    // code path silently did here) doesn't throw, it just fabricates a fresh random id, which
    // would have created a new orphaned Stage set on every single change. Personal writes go
    // straight to the raw `status` field instead; the frontend supplies the matching display
    // (`PERSONAL_DEFAULT_STAGES`) itself rather than reading a `stage` object that can't exist.
    if (!workspaceId) {
      if (!input.status) {
        const err: any = new Error("status is required for a personal response");
        err.statusCode = 422;
        throw err;
      }
      const fromStageId = existingResponse.stageId ? existingResponse.stageId.toString() : null;
      const updated = await ResponseModel.findByIdAndUpdate(responseId, { $set: { status: input.status } }, { new: true });
      if (!updated) {
        const err: any = new Error("Response not found");
        err.statusCode = 404;
        throw err;
      }
      return {
        response: {
          _id: updated._id.toString(),
          formId: updated.formId.toString(),
          answers: cleanAnswers(updated.answers),
          stageId: undefined,
          stage: null,
          status: updated.status,
          submittedAt: updated.submittedAt,
          ipHash: updated.ipHash,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
        fromStageId,
        toStageId: input.status,
      };
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
        answers: cleanAnswers(updated.answers),
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

  async deleteResponse(workspaceId: string, responseId: string, callerUserId?: string): Promise<boolean> {
    const response = await this.responseRepository.findById(responseId);
    if (!response) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    const form = await this.formRepository.findById(response.formId.toString());
    if (!form || !ownsResponseForm(form, workspaceId, callerUserId)) {
      const err: any = new Error("Forbidden: You do not own this response's workspace");
      err.statusCode = 403;
      throw err;
    }

    // Sprint 13 (CF5.5) - BREAKING: this used to destroy the response and its files. It now moves it to
    // Trash (a soft delete); the retention sweep removes it for good after 30 days, or an Owner/Admin
    // can do so sooner from Trash. Files are kept until then.
    await ResponseModel.updateOne(
      { _id: response._id },
      { $set: { deletedAt: new Date(), deletedBy: callerUserId ? new mongoose.Types.ObjectId(callerUserId) : null } }
    );

    return true;
  }

  // Sprint 13, BE 0.12 (A5.2). A member acknowledges a respondent's edit ("Mark as reviewed"), clearing the
  // Edited-after-review flag. Same ownership rule as every other response-scoped write.
  async clearEditedAfterReview(workspaceId: string, responseId: string, callerUserId?: string): Promise<{ cleared: boolean }> {
    const response = await this.responseRepository.findById(responseId);
    if (!response || response.deletedAt) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }
    const form = await this.formRepository.findById(response.formId.toString());
    if (!form || !ownsResponseForm(form, workspaceId, callerUserId)) {
      const err: any = new Error("Forbidden: You do not own this response's workspace");
      err.statusCode = 403;
      throw err;
    }
    const wasSet = !!response.editedAfterReviewAt;
    if (wasSet) await ResponseModel.updateOne({ _id: response._id }, { $set: { editedAfterReviewAt: null } });
    return { cleared: wasSet };
  }

  async getResponseFileUrl(
    workspaceId: string,
    responseId: string,
    fileId: string,
    host: string,
    protocol: string,
    isGrant?: boolean,
    callerUserId?: string
  ): Promise<{ url: string }> {
    const response = await this.responseRepository.findById(responseId);
    if (!response) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    const form = await this.formRepository.findById(response.formId.toString());
    if (!isGrant && !ownsResponseForm(form, workspaceId, callerUserId)) {
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
    assigneeId: string | null,
    callerUserId?: string
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
    if (!form || !ownsResponseForm(form, workspaceId, callerUserId)) {
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

    // Bug fix, Sprint 12 close-out: this response only ever carried `assigneeId` (a raw id) —
    // AssigneePicker needs the resolved `assignee` object to render a name, so the PATCH response
    // showed the change had saved (assigneeId was correct) while the sidebar itself never
    // reflected it, since nothing consuming this response ever had a name to display.
    const assigneeUser = updated.assigneeId ? await User.findById(updated.assigneeId) : null;

    return {
      response: {
        _id: updated._id.toString(),
        formId: updated.formId.toString(),
        answers: cleanAnswers(updated.answers),
        assigneeId: updated.assigneeId ? updated.assigneeId.toString() : null,
        assignee: toAssigneeSummary(assigneeUser),
        status: updated.status,
        stageId: updated.stageId ? updated.stageId.toString() : undefined,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
      previousAssigneeId,
    };
  }

  // Bug fix, Sprint 12 close-out: no service method (and no controller branch) ever handled a
  // full tagIds replace — see updateResponseTagsSchema's comment for the 422 this caused. Full
  // replace, not add/remove, matching the frontend's own computed-full-list `updateTags` call.
  async updateResponseTags(
    workspaceId: string,
    responseId: string,
    tagIds: string[],
    callerUserId?: string
  ): Promise<{ response: IResponse; previousTagIds: string[] }> {
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
    if (!ownsResponseForm(form, workspaceId, callerUserId)) {
      const err: any = new Error("Forbidden: You do not own this response's workspace");
      err.statusCode = 403;
      throw err;
    }

    const uniqueTagIds = [...new Set(tagIds)];
    if (uniqueTagIds.length > 0) {
      const validTagIds = new Set(
        (await TagModel.find({ _id: { $in: uniqueTagIds }, workspaceId }).select("_id")).map((t) => t._id.toString())
      );
      const invalid = uniqueTagIds.filter((id) => !validTagIds.has(id));
      if (invalid.length > 0) {
        const err: any = new Error("One or more tags do not exist in this workspace");
        err.statusCode = 422;
        err.code = "INVALID_TAG";
        throw err;
      }
    }

    const previousTagIds = (existing.tagIds || []).map((t) => t.toString());
    const updated = await ResponseModel.findByIdAndUpdate(
      responseId,
      { $set: { tagIds: uniqueTagIds.map((id) => new mongoose.Types.ObjectId(id)) } },
      { new: true }
    );
    if (!updated) {
      const err: any = new Error("Response not found");
      err.statusCode = 404;
      throw err;
    }

    const tagDocs = uniqueTagIds.length ? await TagModel.find({ _id: { $in: uniqueTagIds } }) : [];
    const tagsById = new Map<string, ITag>(tagDocs.map((t) => [t._id.toString(), t]));

    return {
      response: {
        _id: updated._id.toString(),
        formId: updated.formId.toString(),
        answers: cleanAnswers(updated.answers),
        tagIds: uniqueTagIds,
        tags: toTagSummaries(updated.tagIds, tagsById),
        status: updated.status,
        stageId: updated.stageId ? updated.stageId.toString() : undefined,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      },
      previousTagIds,
    };
  }

  // A "current member with access to the response's form": either a workspace membership of the
  // form's own workspace, or a per-form access grant. Delegates to the shared helper (also used
  // by bulk.service.ts and note.service.ts) so all three never drift apart.
  async userHasAccessToForm(userId: string, formId: string, workspaceId: string | null): Promise<boolean> {
    return userHasAccessToFormShared(userId, formId, workspaceId);
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

  // Sprint 12, BE 0.6 (B3.3/F16). Called by team.controller.ts's removeMember AFTER the membership
  // row is deleted, so it never blocks or fails the removal itself: every response in this
  // workspace currently assigned to the removed user is unassigned (assigneeId -> null), one
  // workspace event written per response. `assignee=unassigned` filtering (responseFilters.ts /
  // getResponses) already treats a null assigneeId as unassigned, so nothing else is needed for
  // "findable under Unassigned" — verified, not assumed.
  async offboardMemberAssignments(
    workspaceId: string,
    removedUserId: string,
    actor: { id: string; email: string; name: string }
  ): Promise<{ responsesUnassigned: number }> {
    const forms = await this.formRepository.findWithPagination({ workspaceId }, 0, 10000, workspaceId);
    const formIds = forms.map((f) => f._id);
    if (formIds.length === 0) return { responsesUnassigned: 0 };

    const assigned = await ResponseModel.find({
      formId: { $in: formIds },
      assigneeId: new mongoose.Types.ObjectId(removedUserId),
      deletedAt: null,
    })
      .select("_id")
      .lean();

    for (const r of assigned) {
      await ResponseModel.updateOne({ _id: r._id }, { $set: { assigneeId: null } });
      // logWorkspaceEvent swallows its own errors (see event.service.ts) so one failed event write
      // never stops the rest of the unassign loop or the member removal that triggered it.
      await logWorkspaceEvent({
        workspaceId,
        actor,
        action: "response.offboard_unassign",
        targetId: r._id.toString(),
        targetType: "response",
        targetLabel: r._id.toString(),
        metadata: { removedUserId, toAssigneeId: null },
      });
    }

    return { responsesUnassigned: assigned.length };
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
