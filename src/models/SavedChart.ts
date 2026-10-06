import mongoose, { Schema, Document } from "mongoose";

// Sprint 14 (B5.5 pt 2, OQ-1) + charts v2: a user's chart on a form's Insights page. Per form AND per user:
// `private` (default) is seen only by its owner, `workspace` by everyone who can read analytics on the form.
// Sprint 14 charts have no ownerId/visibility/position/size/...: they are read as owner=createdBy,
// visibility=workspace, position=order, size=medium (see chart.controller `normalise`; migrate:charts-v2
// writes those values down). Deliberately no schema defaults for the v2 fields so a legacy row is never
// silently given 'private' on load.
export const CHART_TYPES = ["pie", "donut", "bar", "hbar", "line", "area", "stat"] as const;
export const CHART_GROUP_BYS = ["value", "day", "week"] as const; // legacy Sprint 14 shape
export const CHART_SIZES = ["small", "medium", "large"] as const;
export const CHART_VISIBILITIES = ["private", "workspace"] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export type ChartGroupBy = (typeof CHART_GROUP_BYS)[number];

export interface IChartOptions {
  valueMode: "count" | "percent";
  legend: boolean;
  sort: "value" | "order";
}

export interface ISavedChart extends Document {
  formId: mongoose.Types.ObjectId;
  workspaceId?: mongoose.Types.ObjectId | null;
  fieldId: string;
  chartType: ChartType;
  groupBy?: ChartGroupBy; // legacy, kept in step with `granularity` for old clients
  createdBy?: mongoose.Types.ObjectId | null; // legacy name of ownerId
  ownerId?: mongoose.Types.ObjectId | null;
  visibility?: (typeof CHART_VISIBILITIES)[number];
  size?: (typeof CHART_SIZES)[number];
  title?: string;
  options?: IChartOptions;
  granularity?: "day" | "week" | "month" | null;
  position?: number;
  order: number; // legacy name of position, mirrored on write
  createdAt: Date;
  updatedAt: Date;
}

const SavedChartSchema = new Schema<ISavedChart>(
  {
    formId: { type: Schema.Types.ObjectId, ref: "Form", required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null },
    fieldId: { type: String, required: true },
    chartType: { type: String, enum: CHART_TYPES, required: true },
    groupBy: { type: String, enum: CHART_GROUP_BYS },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    ownerId: { type: Schema.Types.ObjectId, ref: "User" },
    visibility: { type: String, enum: CHART_VISIBILITIES },
    size: { type: String, enum: CHART_SIZES },
    title: { type: String, maxlength: 120 },
    options: {
      type: new Schema({ valueMode: String, legend: Boolean, sort: String }, { _id: false }),
    },
    granularity: { type: String, enum: ["day", "week", "month", null] },
    position: { type: Number },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

SavedChartSchema.index({ formId: 1, order: 1, createdAt: 1 });
SavedChartSchema.index({ formId: 1, ownerId: 1 });

const SavedChart = mongoose.model<ISavedChart>("SavedChart", SavedChartSchema);
export default SavedChart;
