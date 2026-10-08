import mongoose, { Schema, Document } from "mongoose";

// Saved home-dashboard layout. workspaceId null = personal (one per owner+kind);
// workspace docs are ONE shared document per (workspaceId, kind), ownerId = last editor.
export interface IDashboard extends Document {
  ownerId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId | null;
  kind: "home";
  widgets: unknown[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const DashboardSchema = new Schema<IDashboard>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null },
    kind: { type: String, enum: ["home"], default: "home" },
    widgets: { type: [Schema.Types.Mixed], default: [] },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

DashboardSchema.index(
  { ownerId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { workspaceId: null } }
);
DashboardSchema.index(
  { workspaceId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { workspaceId: { $type: "objectId" } } }
);

export default mongoose.model<IDashboard>("Dashboard", DashboardSchema);
