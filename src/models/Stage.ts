import mongoose, { Schema, Document } from "mongoose";

// Workspace-defined pipeline stage (Sprint 12, BE 0.1). Replaces the fixed Response.status enum
// as the primary source of truth for where a response sits in the workspace's pipeline; `category`
// is what keeps every pre-Sprint-12 consumer (list filter, /stats, analytics, reports) working,
// since Response.status is kept in sync with the stage's category on every write.
export type StageCategory = "new" | "in_progress" | "completed";

export interface IStage extends Document {
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  colour: string; // a design-token name (e.g. "slate"), never a raw hex value
  order: number;
  category: StageCategory;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const StageSchema = new Schema<IStage>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    colour: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
    category: {
      type: String,
      enum: ["new", "in_progress", "completed"],
      required: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Ordered listing per workspace is the hot path (every GET /stages call).
StageSchema.index({ workspaceId: 1, order: 1 });

const StageModel = mongoose.model<IStage>("Stage", StageSchema);
export default StageModel;
