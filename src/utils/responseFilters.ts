import mongoose from "mongoose";
import ResponseModel from "../models/Response";
import ResponseReadState from "../models/ResponseReadState";
import { escapeRegex } from "./safeInput";

// Shared filter shape (Sprint 12, BE 0.2) consumed by the bulk endpoint's `filter` target and by
// the filtered export (POST /api/reports). Kept in one place so both build the exact same query
// the list endpoint would, rather than two slightly-different re-implementations drifting apart.
export interface ResponseFilters {
  formId?: string;
  stageId?: string;
  tagIds?: string[];
  assigneeId?: string; // an id, or 'unassigned' / 'me'
  unread?: boolean;
  // Sprint 12, BE 0.6 (B4.10): true = only responses flagged as a duplicate (duplicateOfId set).
  duplicate?: boolean;
  from?: string;
  to?: string;
  q?: string;
}

// `workspaceFormIds` scopes the query to forms the caller is allowed to see (workspace forms,
// optionally narrowed further by `filters.formId`). `callerUserId` is required only when
// `filters.unread` is set.
export const buildResponseFilterQuery = async (
  filters: ResponseFilters,
  workspaceFormIds: mongoose.Types.ObjectId[],
  callerUserId?: string
): Promise<any> => {
  const query: any = { deletedAt: null };

  if (filters.formId && mongoose.Types.ObjectId.isValid(filters.formId)) {
    const formObjId = new mongoose.Types.ObjectId(filters.formId);
    query.formId = workspaceFormIds.some((id) => id.equals(formObjId)) ? formObjId : { $in: [] };
  } else {
    query.formId = { $in: workspaceFormIds };
  }

  if (filters.stageId && mongoose.Types.ObjectId.isValid(filters.stageId)) {
    query.stageId = new mongoose.Types.ObjectId(filters.stageId);
  }

  if (filters.duplicate) {
    query.duplicateOfId = { $ne: null };
  }

  if (filters.tagIds && filters.tagIds.length > 0) {
    const validTagIds = filters.tagIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validTagIds.length > 0) query.tagIds = { $in: validTagIds };
  }

  if (filters.assigneeId === "unassigned") {
    query.assigneeId = null;
  } else if (filters.assigneeId === "me") {
    if (callerUserId) query.assigneeId = new mongoose.Types.ObjectId(callerUserId);
  } else if (filters.assigneeId && mongoose.Types.ObjectId.isValid(filters.assigneeId)) {
    query.assigneeId = new mongoose.Types.ObjectId(filters.assigneeId);
  }

  if (filters.from || filters.to) {
    const submittedAtQuery: any = {};
    if (filters.from) {
      const d = new Date(filters.from);
      if (!isNaN(d.getTime())) submittedAtQuery.$gte = d;
    }
    if (filters.to) {
      const d = new Date(filters.to);
      if (!isNaN(d.getTime())) submittedAtQuery.$lte = d;
    }
    if (Object.keys(submittedAtQuery).length > 0) query.submittedAt = submittedAtQuery;
  }

  if (filters.q && filters.q.trim() !== "") {
    const searchRegex = new RegExp(escapeRegex(filters.q.trim().toLowerCase()), "i");
    query.searchText = searchRegex;
  }

  if (filters.unread) {
    if (!callerUserId) {
      // No caller to scope "unread" to: match nothing rather than guessing.
      query._id = { $in: [] };
    } else {
      const candidateIds = await ResponseModel.find(query).select("_id").lean();
      const readRows = await ResponseReadState.find({
        userId: callerUserId,
        responseId: { $in: candidateIds.map((c) => c._id) },
      })
        .select("responseId")
        .lean();
      const readSet = new Set(readRows.map((r) => r.responseId.toString()));
      const unreadIds = candidateIds.map((c) => c._id).filter((id) => !readSet.has(id.toString()));
      query._id = { $in: unreadIds };
    }
  }

  return query;
};
