import mongoose, { Schema, Document } from "mongoose";

export const TABLE_BUILTIN_COLUMNS = ["respondent", "email", "tags", "assignee", "stage", "submitted", "score", "notes"] as const;
export const DEFAULT_TABLE_COLUMNS: string[] = ["respondent", "email", "tags", "assignee", "stage", "submitted"];
export const OPENS_AS = ["table", "board", "calendar"] as const;
export const RESPONSE_SORTS = ["newest", "oldest"] as const; // by submission time; the server sorts nothing else
export const ROW_HEIGHTS = ["comfortable", "compact"] as const;
export const MAX_TABLE_COLUMNS = 30;

export type OpensAs = (typeof OPENS_AS)[number];
export type ResponseSort = (typeof RESPONSE_SORTS)[number];
export type RowHeight = (typeof ROW_HEIGHTS)[number];

/**
 * How one form's Responses page is set up, for everyone who opens it ("Customize" on the Responses page; owner and admins only).
 * One row per form. A form with no row looks exactly as it always did: see DEFAULT_SETUP in responseSetup.service.ts.
 * Column and field references are stored as written and checked against the form's live questions when they are read, so a deleted
 * question just disappears from the table instead of breaking it. The form's own stages are Stage rows with this form's id.
 */
export interface IResponseSetup extends Document {
  workspaceId: mongoose.Types.ObjectId | null; // null for personal forms
  formId: mongoose.Types.ObjectId;
  /** Table columns, left to right: a built-in key (TABLE_BUILTIN_COLUMNS) or `q:<fieldId>` for a question. */
  tableColumns: string[];
  /** The question that headlines a Board card, or "auto" (the respondent's name, else their email). */
  cardTitle: string;
  opensAs: OpensAs;
  sort: ResponseSort;
  /** The question that names the respondent in the table, board and response panel, or "auto". */
  respondentFrom: string;
  rowHeight: RowHeight;
  wrap: boolean;
  /** A new response starts in this stage; only meaningful when the form has its own stages. */
  startStageId: mongoose.Types.ObjectId | null;
  version: number; // compare-and-swap counter for the stale-save guard (409)
  updatedBy: mongoose.Types.ObjectId;
  updatedAt: Date;
}

const ResponseSetupSchema = new Schema<IResponseSetup>({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null },
  formId: { type: Schema.Types.ObjectId, ref: "Form", required: true },
  tableColumns: { type: [String], default: () => [...DEFAULT_TABLE_COLUMNS], validate: (v: string[]) => v.length >= 1 && v.length <= MAX_TABLE_COLUMNS },
  cardTitle: { type: String, default: "auto", maxlength: 80 },
  opensAs: { type: String, enum: OPENS_AS, default: "table" },
  sort: { type: String, enum: RESPONSE_SORTS, default: "newest" },
  respondentFrom: { type: String, default: "auto", maxlength: 80 },
  rowHeight: { type: String, enum: ROW_HEIGHTS, default: "comfortable" },
  wrap: { type: Boolean, default: false },
  startStageId: { type: Schema.Types.ObjectId, ref: "Stage", default: null },
  version: { type: Number, default: 1 },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  updatedAt: { type: Date, default: Date.now },
});

ResponseSetupSchema.index({ formId: 1 }, { unique: true });
ResponseSetupSchema.index({ workspaceId: 1 });

export default mongoose.model<IResponseSetup>("ResponseSetup", ResponseSetupSchema);
