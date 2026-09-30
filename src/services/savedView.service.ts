import mongoose from "mongoose";
import SavedViewModel, { ISavedView, SavedViewVisibility, SavedViewMode } from "../models/SavedView";

function notFound(message: string): never {
  const err: any = new Error(message);
  err.statusCode = 404;
  throw err;
}

function forbidden(message: string): never {
  const err: any = new Error(message);
  err.statusCode = 403;
  throw err;
}

const toJson = (view: ISavedView, ownerName: string) => ({
  id: view._id.toString(),
  name: view.name,
  ownerId: view.ownerId.toString(),
  ownerName,
  visibility: view.visibility,
  formId: view.formId ? view.formId.toString() : null,
  filters: view.filters,
  viewMode: view.viewMode,
  createdAt: view.createdAt,
});

export class SavedViewService {
  // Personal views: only ever returned to their owner. Team views: every member of the scope
  // (workspace or, for the personal shell, the caller themself — there's no "team" concept there
  // to widen to). Stores filters, never results — this is a query over SavedView documents, not
  // over Responses (design.md §11.1's own guarantee).
  async listViews(
    workspaceId: string | null,
    formId: string | null,
    callerUserId: string
  ): Promise<ReturnType<typeof toJson>[]> {
    const scopeQuery: any = { workspaceId, formId };
    const views = await SavedViewModel.find({
      ...scopeQuery,
      $or: [{ ownerId: callerUserId }, { visibility: "team" }],
    }).sort({ createdAt: -1 });

    // Owner display name is resolved by the caller (a single batched User lookup covers every
    // row) — "Unknown" here is only ever a placeholder the controller replaces.
    return views.map((v) => toJson(v, "Unknown"));
  }

  async createView(
    workspaceId: string | null,
    callerUserId: string,
    ownerName: string,
    canCreateTeamView: boolean,
    data: { name: string; visibility: SavedViewVisibility; formId?: string | null; filters: Record<string, unknown>; viewMode: SavedViewMode }
  ): Promise<ReturnType<typeof toJson>> {
    if (data.visibility === "team" && !canCreateTeamView) {
      forbidden("Forbidden: only Editor role or above may create a team view");
    }
    if (data.visibility === "team" && !workspaceId) {
      forbidden("Forbidden: a team view requires a workspace");
    }

    const view = await SavedViewModel.create({
      name: data.name,
      ownerId: new mongoose.Types.ObjectId(callerUserId),
      workspaceId: workspaceId ? new mongoose.Types.ObjectId(workspaceId) : null,
      visibility: data.visibility,
      formId: data.formId ? new mongoose.Types.ObjectId(data.formId) : null,
      filters: data.filters ?? {},
      viewMode: data.viewMode ?? "table",
    });

    return toJson(view, ownerName);
  }

  async updateView(
    id: string,
    callerUserId: string,
    isWorkspaceAdminPlus: boolean,
    ownerName: string,
    patch: Partial<{ name: string; visibility: SavedViewVisibility; filters: Record<string, unknown>; viewMode: SavedViewMode }>
  ): Promise<ReturnType<typeof toJson>> {
    const view = await this.findOwnedOrAdmin(id, callerUserId, isWorkspaceAdminPlus);
    if (patch.name !== undefined) view.name = patch.name;
    if (patch.visibility !== undefined) view.visibility = patch.visibility;
    if (patch.filters !== undefined) view.filters = patch.filters;
    if (patch.viewMode !== undefined) view.viewMode = patch.viewMode;
    await view.save();
    return toJson(view, ownerName);
  }

  async removeView(id: string, callerUserId: string, isWorkspaceAdminPlus: boolean): Promise<void> {
    const view = await this.findOwnedOrAdmin(id, callerUserId, isWorkspaceAdminPlus);
    await SavedViewModel.deleteOne({ _id: view._id });
  }

  // Rename/visibility-change/delete: owner, or Admin+ for a team-scoped view (requirements.md
  // §7.6 — "Rename / change visibility / delete only for the owner, or Admin+ for Team views").
  private async findOwnedOrAdmin(id: string, callerUserId: string, isWorkspaceAdminPlus: boolean): Promise<ISavedView> {
    if (!mongoose.Types.ObjectId.isValid(id)) notFound("Saved view not found");
    const view = await SavedViewModel.findById(id);
    if (!view) notFound("Saved view not found");
    const isOwner = view!.ownerId.toString() === callerUserId;
    if (!isOwner && !(view!.visibility === "team" && isWorkspaceAdminPlus)) {
      forbidden("Forbidden: only the owner, or an Admin+ for a team view, may modify this saved view");
    }
    return view!;
  }
}
