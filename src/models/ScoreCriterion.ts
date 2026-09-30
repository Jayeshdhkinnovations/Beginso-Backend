import mongoose, { Schema, Document } from "mongoose";

// Workspace-defined scoring criterion (Sprint 12, BE 0.5 / B6.1, OQ-7 resolved 3 Oct 2026).
// Same pattern as Stage.ts: workspace-scoped, ordered, one default seeded automatically.
export interface IScoreCriterion extends Document {
  workspaceId: mongoose.Types.ObjectId;
  label: string;
  order: number;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ScoreCriterionSchema = new Schema<IScoreCriterion>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    // The default criterion is seeded unnamed (empty label) — the frontend displays a fallback
    // like "Score" for an empty label rather than a stored placeholder string.
    label: {
      type: String,
      required: false,
      default: "",
      trim: true,
      maxlength: 60,
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

ScoreCriterionSchema.index({ workspaceId: 1, order: 1 });

const ScoreCriterionModel = mongoose.model<IScoreCriterion>("ScoreCriterion", ScoreCriterionSchema);
export default ScoreCriterionModel;
