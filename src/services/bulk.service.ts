import mongoose from "mongoose";
import { queueActivityEmails } from "./notificationEmail.service";
import ResponseModel, { IResponse as IResponseDoc } from "../models/Response";
import Form from "../models/Form";
import TagModel from "../models/Tag";
import FormAccessGrant from "../models/FormAccessGrant";
import Notification from "../models/Notification";
import { hasPermission } from "../middleware/permission.middleware";
import { WorkspaceRole } from "../types/workspace.types";
import { ResponseService } from "./response.service";
import { ReadStateService } from "./readState.service";
import { StageService } from "./stage.service";
import { logWorkspaceEvent } from "./event.service";
import { buildResponseFilterQuery, ResponseFilters } from "../utils/responseFilters";
import { MAX_BULK_BATCH_SIZE, BulkAction, BulkTarget } from "../validations/bulk.validator";

export interface BulkPrevious {
  id: string;
  stageId?: string | null;
  assigneeId?: string | null;
  tagIds?: string[];
  read?: boolean;
  deletedAt?: Date | null;
}

export interface BulkResult {
  succeeded: string[];
  failed: { id: string; reason: string }[];
  previous: BulkPrevious[];
}

export interface BulkActor {
  id: string;
  email: string;
  name: string;
}

const badRequest = (message: string, statusCode = 400): never => {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  throw err;
};

const requiredPermissionFor = (action: BulkAction): string => {
  if (action.type === "delete" || action.type === "restore") return "responses:delete";
  if (action.type === "read" || action.type === "unread") return "responses:read";
  return "responses:write";
};

export class BulkService {
  private responseService = new ResponseService();
  private readStateService = new ReadStateService();
  private stageService = new StageService();

  // Resolves the target into a candidate id list, capped at MAX_BULK_BATCH_SIZE + 1 so an
  // over-cap request can be told apart from one that exactly fills it.
  private async resolveCandidateIds(
    target: BulkTarget,
    callerWorkspaceId: string,
    callerUserId: string
  ): Promise<string[]> {
    if ("ids" in target) {
      return target.ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    }

    // filter target: re-evaluated server-side against the caller's own workspace forms, never
    // trusted from the client beyond the filter shape itself.
    // Personal context (no workspace): only the caller's own personal forms.
    const workspaceForms = await Form.find(
      callerWorkspaceId
        ? { workspaceId: callerWorkspaceId }
        : { createdBy: callerUserId, $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }] }
    )
      .select("_id")
      .lean();
    const workspaceFormIds = workspaceForms.map((f) => f._id);

    const query = await buildResponseFilterQuery(
      (target.filter || {}) as ResponseFilters,
      target.formId ? workspaceFormIds.filter((id) => id.toString() === target.formId) : workspaceFormIds,
      callerUserId
    );
    const matches = await ResponseModel.find(query).select("_id").limit(MAX_BULK_BATCH_SIZE + 1).lean();
    return matches.map((m) => m._id.toString());
  }

  async run(
    target: BulkTarget,
    action: BulkAction,
    context: { callerWorkspaceId: string; callerWorkspaceRole: WorkspaceRole | null; actor: BulkActor; ip?: string }
  ): Promise<BulkResult> {
    const candidateIds = await this.resolveCandidateIds(target, context.callerWorkspaceId, context.actor.id);

    if (candidateIds.length > MAX_BULK_BATCH_SIZE) {
      badRequest(`Bulk request exceeds the maximum batch size of ${MAX_BULK_BATCH_SIZE}`, 413);
    }
    if (candidateIds.length === 0) {
      return { succeeded: [], failed: [], previous: [] };
    }

    const responses = await ResponseModel.find({ _id: { $in: candidateIds } });
    const responseById = new Map(responses.map((r) => [r._id.toString(), r]));

    const formIds = [...new Set(responses.map((r) => r.formId.toString()))];
    const forms = await Form.find({ _id: { $in: formIds } });
    const formById = new Map(forms.map((f) => [f._id.toString(), f]));

    const requiredPermission = requiredPermissionFor(action);

    const succeeded: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    const previous: BulkPrevious[] = [];

    for (const id of candidateIds) {
      const response = responseById.get(id);
      if (!response) {
        failed.push({ id, reason: "Response not found" });
        continue;
      }
      const form = formById.get(response.formId.toString());
      if (!form) {
        failed.push({ id, reason: "Response not found" });
        continue;
      }

      const allowed = await this.canAct(form, context, requiredPermission, context.actor.id);
      if (!allowed) {
        failed.push({ id, reason: "Forbidden: insufficient permission for this response" });
        continue;
      }

      try {
        const prev = await this.applyOne(response, form, action, context);
        previous.push(prev);
        succeeded.push(id);

        if (form.workspaceId) {
          await logWorkspaceEvent({
            workspaceId: form.workspaceId,
            actor: context.actor,
            action: `response.bulk_${action.type}`,
            targetId: id,
            targetType: "response",
            targetLabel: id,
            metadata: { action },
            ip: context.ip,
          });
        }
      } catch (err: any) {
        failed.push({ id, reason: err?.message || "Failed to apply action" });
      }
    }

    return { succeeded, failed, previous };
  }

  private async canAct(
    form: any,
    context: { callerWorkspaceId: string; callerWorkspaceRole: WorkspaceRole | null },
    requiredPermission: string,
    actorUserId: string
  ): Promise<boolean> {
    if (
      form.workspaceId &&
      form.workspaceId.toString() === context.callerWorkspaceId &&
      context.callerWorkspaceRole &&
      hasPermission(context.callerWorkspaceRole, requiredPermission)
    ) {
      return true;
    }
    // A personal form has no workspace role to check: its creator is its owner (full access).
    if (!form.workspaceId && form.createdBy && form.createdBy.toString() === actorUserId) return true;
    const grant = await FormAccessGrant.findOne({ formId: form._id, userId: actorUserId }).lean();
    if (grant && hasPermission(grant.role, requiredPermission)) return true;
    return false;
  }

  private async applyOne(
    response: IResponseDoc,
    form: any,
    action: BulkAction,
    context: { actor: BulkActor }
  ): Promise<BulkPrevious> {
    const id = response._id.toString();

    switch (action.type) {
      case "stage": {
        const scopeWorkspaceId = form.workspaceId ? form.workspaceId.toString() : null;
        if (!scopeWorkspaceId) badRequest("This response's form has no workspace to resolve stages against");
        const stage = await this.stageService.getStageInWorkspace(scopeWorkspaceId!, action.stageId);
        const prevStageId = response.stageId ? response.stageId.toString() : null;
        await ResponseModel.updateOne(
          { _id: response._id },
          { $set: { stageId: stage._id, status: stage.category } }
        );
        return { id, stageId: prevStageId };
      }
      case "assign": {
        const prevAssigneeId = response.assigneeId ? response.assigneeId.toString() : null;
        if (action.assigneeId !== null) {
          const ok = await this.responseService.userHasAccessToForm(
            action.assigneeId,
            form._id.toString(),
            form.workspaceId ? form.workspaceId.toString() : null
          );
          if (!ok) badRequest("assigneeId must be a current member with access to this response's form", 422);
        }
        await ResponseModel.updateOne(
          { _id: response._id },
          { $set: { assigneeId: action.assigneeId ? new mongoose.Types.ObjectId(action.assigneeId) : null } }
        );
        if (action.assigneeId && action.assigneeId !== context.actor.id && form.workspaceId) {
          const notification = await Notification.create({
            userId: action.assigneeId,
            workspaceId: form.workspaceId,
            type: "assignment",
            title: "Response assigned to you",
            message: `${context.actor.name} assigned a response to you`,
          }).catch(() => null);
          if (notification) {
            queueActivityEmails({ kind: "assignment", formId: form._id, responseId: response._id, eventKey: notification._id.toString(), recipientUserId: action.assigneeId });
          }
        }
        return { id, assigneeId: prevAssigneeId };
      }
      case "tag": {
        if (!form.workspaceId) badRequest("This response's form has no workspace to resolve tags against");
        const tag = await TagModel.findOne({ _id: action.tagId, workspaceId: form.workspaceId }).lean();
        if (!tag) badRequest("Tag not found", 404);
        const prevTagIds = (response.tagIds || []).map((t) => t.toString());
        await ResponseModel.updateOne({ _id: response._id }, { $addToSet: { tagIds: tag!._id } });
        return { id, tagIds: prevTagIds };
      }
      case "untag": {
        if (!form.workspaceId) badRequest("This response's form has no workspace to resolve tags against");
        const tag = await TagModel.findOne({ _id: action.tagId, workspaceId: form.workspaceId }).lean();
        if (!tag) badRequest("Tag not found", 404);
        const prevTagIds = (response.tagIds || []).map((t) => t.toString());
        await ResponseModel.updateOne({ _id: response._id }, { $pull: { tagIds: tag!._id } });
        return { id, tagIds: prevTagIds };
      }
      case "read": {
        const wasUnread = await this.readStateService.isUnread(context.actor.id, id);
        await this.readStateService.markRead(context.actor.id, id);
        return { id, read: !wasUnread };
      }
      case "unread": {
        const wasUnread = await this.readStateService.isUnread(context.actor.id, id);
        await this.readStateService.markUnread(context.actor.id, id);
        return { id, read: !wasUnread };
      }
      case "delete": {
        const prevDeletedAt = response.deletedAt || null;
        await this.responseService.softDeleteResponse(id);
        return { id, deletedAt: prevDeletedAt };
      }
      case "restore": {
        const prevDeletedAt = response.deletedAt || null;
        await this.responseService.restoreResponse(id);
        return { id, deletedAt: prevDeletedAt };
      }
      default:
        return { id };
    }
  }
}
