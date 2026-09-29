import mongoose from "mongoose";
import { Event } from "../models/Event";
import Membership from "../models/Membership";
import ResponseModel from "../models/Response";
import Form from "../models/Form";

// Sprint 12, BE 0.3: read side of the existing events/audit table (C3.6) — the same collection
// BE 0.1's stage-change events and BE 0.2's assign/tag/bulk events already write to. No new
// storage; this only maps stored Event rows onto the activity contract's fixed type vocabulary.
// documented types: submitted, opened, stage_changed, assigned, unassigned, tag_added,
// tag_removed, note_added, scored. "opened" and "scored" are not tracked/built yet respectively,
// so they simply never appear — that is expected, not a bug.
export interface ActivityItem {
  id: string;
  type: string;
  actorName: string;
  actorRemoved: boolean;
  at: Date;
  detail: Record<string, any> | undefined;
}

const notFound = (message: string): never => {
  const err: any = new Error(message);
  err.statusCode = 404;
  throw err;
};

// Maps a stored Event.action (+ metadata) onto the activity endpoint's fixed type vocabulary.
// Returns null for actions outside that vocabulary (e.g. tag.create, workspace.* — never surfaced
// on a per-response timeline).
const toActivityType = (action: string, metadata: Record<string, any> | undefined): string | null => {
  switch (action) {
    case "response.submit":
      return "submitted";
    case "response.status_change":
    case "response.stage_change":
    case "response.bulk_stage":
      return "stage_changed";
    case "response.assign":
    case "response.bulk_assign":
      return metadata?.toAssigneeId ? "assigned" : "unassigned";
    case "response.bulk_tag":
      return "tag_added";
    case "response.bulk_untag":
      return "tag_removed";
    case "response.note_add":
      return "note_added";
    case "response.score":
      return "scored";
    default:
      return null;
  }
};

export class ActivityService {
  async forResponse(responseId: string, workspaceId: string | null): Promise<ActivityItem[]> {
    if (!mongoose.Types.ObjectId.isValid(responseId)) notFound("Response not found");
    const response = await ResponseModel.findById(responseId).select("formId").lean();
    if (!response) notFound("Response not found");

    const form = await Form.findById(response!.formId).select("workspaceId").lean();
    const scopeWorkspaceId = workspaceId || (form?.workspaceId ? form.workspaceId.toString() : null);

    // Personal (workspace-less) responses have no workspace event feed (event.service.ts's own
    // convention — see recordEvent's comment), so there is simply nothing to read.
    if (!scopeWorkspaceId) return [];

    const events = await Event.find({ targetType: "response", targetId: responseId, workspaceId: scopeWorkspaceId })
      .sort({ createdAt: 1 }) // oldest first == "newest last"
      .lean();

    const actorIds = [...new Set(events.filter((e) => e.actorId).map((e) => e.actorId!.toString()))];
    const stillMemberIds = actorIds.length
      ? new Set(
          (await Membership.find({ userId: { $in: actorIds }, workspaceId: scopeWorkspaceId }).select("userId").lean()).map(
            (m) => m.userId.toString()
          )
        )
      : new Set<string>();

    const items: ActivityItem[] = [];
    for (const e of events) {
      const type = toActivityType(e.action, e.metadata);
      if (!type) continue;
      items.push({
        id: e._id.toString(),
        type,
        actorName: e.actorName,
        // A null actorId (e.g. an unauthenticated submitter) was never a member to begin with.
        actorRemoved: !!e.actorId && !stillMemberIds.has(e.actorId.toString()),
        at: e.createdAt,
        // Never the raw `ip` field (existing rule: ipHash only, never a raw address) — metadata
        // never carried one to begin with, so this is naturally satisfied, not filtered here.
        detail: e.metadata,
      });
    }
    return items;
  }
}
