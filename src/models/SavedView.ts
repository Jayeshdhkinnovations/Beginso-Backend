import mongoose, { Schema, Document } from "mongoose";

// Saved Inbox view (Sprint 12, BE 0.4 / B7.1). Personal views are returned only to their owner;
// team views are visible to every member with access to the scope but never widen what they can
// see — they store filters, never results (design.md §11.1). `workspaceId: null` + `ownerId` is
// the personal-shell equivalent of a workspace-owned resource, same convention as `Form`.
export type SavedViewVisibility = "personal" | "team";
export type SavedViewMode = "table" | "board" | "calendar" | "chart";

export interface ISavedView extends Document {
  name: string;
  ownerId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId | null;
  visibility: SavedViewVisibility;
  formId: mongoose.Types.ObjectId | null;
  filters: Record<string, unknown>;
  viewMode: SavedViewMode;
  createdAt: Date;
  updatedAt: Date;
}

const SavedViewSchema = new Schema<ISavedView>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null, index: true },
    visibility: { type: String, enum: ["personal", "team"], required: true, default: "personal" },
    formId: { type: Schema.Types.ObjectId, ref: "Form", default: null },
    filters: { type: Schema.Types.Mixed, default: {} },
    viewMode: { type: String, enum: ["table", "board", "calendar", "chart"], default: "table" },
  },
  { timestamps: true }
);

// List query is always scoped by workspace (or null for personal) + formId, then split by
// visibility/owner in the service layer.
SavedViewSchema.index({ workspaceId: 1, formId: 1 });

const SavedViewModel = mongoose.model<ISavedView>("SavedView", SavedViewSchema);
export default SavedViewModel;
