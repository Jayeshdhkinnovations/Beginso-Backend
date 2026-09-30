import mongoose, { Schema, Document } from "mongoose";

export interface IResponse extends Document {
  formId: mongoose.Types.ObjectId;
  answers: Record<string, any>;
  stageId?: mongoose.Types.ObjectId;
  // DEPRECATED (Sprint 12, BE 0.1): kept only so pre-Sprint-12 consumers (list filter, /stats,
  // analytics, reports) keep working without changes. It is derived from stageId's Stage.category
  // and synced on every write that changes stageId — never write status directly once a
  // workspace has stages; write stageId and let the sync keep this correct.
  status?: "new" | "in_progress" | "completed" | string;
  submittedAt?: Date;
  ipHash?: string;
  searchText?: string;
  // Sprint 12, BE 0.3 (B8.1): immutable, human-readable, sequential per form (e.g. "#142").
  // Allocated atomically at submission via reference.service.ts; back-filled for pre-existing
  // responses by scripts/backfillResponseReference.ts. Optional at the schema level only so old
  // fixtures/tests that predate this field keep loading — every response created going forward has one.
  reference?: string;
  // Sprint 12, BE 0.2 (B3.1): many-to-many with Tag, workspace-scoped.
  tagIds: mongoose.Types.ObjectId[];
  // Sprint 12, BE 0.2 (B3.2/R4): nullable current-member assignee.
  assigneeId?: mongoose.Types.ObjectId | null;
  // Sprint 12, BE 0.2 (B2.2 / OQ-3): soft delete. null/unset = not deleted. Every list, count,
  // stat, analytics figure and export must filter `deletedAt: null`; files are kept, only the
  // record is hidden. Never write directly — go through ResponseService.softDelete/restore.
  deletedAt?: Date | null;
  // Sprint 12, BE 0.6 (B8.3/OQ-6). Lower-cased value of the form's first `type: "email"` field for
  // this submission, or null if the form has no email field / it was left blank. Stored (not
  // recomputed per read) so duplicate lookup is one indexed query, not a per-response answers scan
  // — see duplicate.service.ts for the extraction + lookup logic and the OQ-6 assumption it records.
  respondentEmail?: string | null;
  // Sprint 12, BE 0.6 (B4.10/B8.3): id of the earliest earlier response to the SAME form whose
  // respondentEmail matched (case-insensitive) at submission time. Flag only — never merged or
  // dropped. null = not a duplicate (or no email field on the form).
  duplicateOfId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const ResponseSchema = new Schema<IResponse>(
  {
    formId: {
      type: Schema.Types.ObjectId,
      ref: "Form",
      required: true,
      index: true,
    },
    answers: {
      type: Schema.Types.Mixed,
      required: true,
    },
    stageId: {
      type: Schema.Types.ObjectId,
      ref: "Stage",
      index: true,
    },
    status: {
      type: String,
      enum: ["new", "in_progress", "completed"],
      default: "new",
      index: true,
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    ipHash: {
      type: String,
      index: true,
    },
    // Lower-cased flat copy of the answer values, used only for response search. Missing on
    // responses stored before it existed until scripts/backfillResponseSearchText.ts has run.
    searchText: {
      type: String,
      select: false,
    },
    reference: {
      type: String,
      index: true,
    },
    tagIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Tag" }],
      default: [],
    },
    assigneeId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
    respondentEmail: {
      type: String,
      default: null,
      index: true,
    },
    duplicateOfId: {
      type: Schema.Types.ObjectId,
      ref: "Response",
      default: null,
    },
  },
  { timestamps: true }
);

// Duplicate lookup at submission time: "earlier responses to this form with this email".
ResponseSchema.index({ formId: 1, respondentEmail: 1 });

// Compound indexes for fast listing, filtering & sorting by formId + submittedAt (+ status/stage)
ResponseSchema.index({ formId: 1, submittedAt: -1, status: 1 });
ResponseSchema.index({ formId: 1, submittedAt: -1, stageId: 1 });
ResponseSchema.index({ formId: 1, submittedAt: -1 });
ResponseSchema.index({ submittedAt: -1 });
ResponseSchema.index({ formId: 1, deletedAt: 1 });
ResponseSchema.index({ tagIds: 1 });

// Submissions listing sorts by createdAt within a form.
ResponseSchema.index({ formId: 1, createdAt: -1 });

const ResponseModel = mongoose.model<IResponse>("Response", ResponseSchema);
export default ResponseModel;
