import mongoose, { Schema, Document } from "mongoose";

// ponytail: single-node local disk durability constraint. Cloud storage (R2/S3) is the documented P1 upgrade path.

export type ReportFormat = "csv" | "pdf";
export type ReportStatus = "queued" | "processing" | "completed" | "failed" | "expired";

export interface IReportFilters {
  formId?: string;
  status?: string;
  search?: string;
  from?: string;
  to?: string;
}

export interface IReport extends Document {
  workspaceId: mongoose.Types.ObjectId;
  format: ReportFormat;
  filters?: IReportFilters;
  status: ReportStatus;
  errorMessage?: string;
  filePath?: string;
  fileSize?: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ReportSchema = new Schema<IReport>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    format: {
      type: String,
      enum: ["csv", "pdf"],
      required: true,
    },
    filters: {
      type: Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "expired"],
      default: "queued",
      index: true,
    },
    errorMessage: {
      type: String,
    },
    filePath: {
      type: String,
    },
    fileSize: {
      type: Number,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

ReportSchema.index({ workspaceId: 1, createdAt: -1 });
// The report queue claims the oldest queued job and recovers stale processing ones.
ReportSchema.index({ status: 1, createdAt: 1 });

const ReportModel = mongoose.model<IReport>("Report", ReportSchema);
export default ReportModel;
