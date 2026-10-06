import mongoose, { Schema, Document } from "mongoose";

// Sprint 14 (B5.5 pt 2, OQ-1): a user-added chart on a form's Insights page. Stored per form, not per viewer.
export const CHART_TYPES = ["bar", "donut", "line"] as const;
export const CHART_GROUP_BYS = ["value", "day", "week"] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export type ChartGroupBy = (typeof CHART_GROUP_BYS)[number];

export interface ISavedChart extends Document {
  formId: mongoose.Types.ObjectId;
  workspaceId?: mongoose.Types.ObjectId | null;
  fieldId: string;
  chartType: ChartType;
  groupBy: ChartGroupBy;
  createdBy?: mongoose.Types.ObjectId | null;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const SavedChartSchema = new Schema<ISavedChart>(
  {
    formId: { type: Schema.Types.ObjectId, ref: "Form", required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null },
    fieldId: { type: String, required: true },
    chartType: { type: String, enum: CHART_TYPES, required: true },
    groupBy: { type: String, enum: CHART_GROUP_BYS, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

SavedChartSchema.index({ formId: 1, order: 1, createdAt: 1 });

const SavedChart = mongoose.model<ISavedChart>("SavedChart", SavedChartSchema);
export default SavedChart;
