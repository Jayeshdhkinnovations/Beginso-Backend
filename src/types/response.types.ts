export interface IAnswer {
  fieldId?: string;
  label?: string;
  fieldLabel?: string;
  value: any;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  [key: string]: any;
}

export interface IResponseFile {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
  uploadTime: Date | string;
}

export interface IResponseStageSummary {
  id: string;
  name: string;
  colour: string;
  category: "new" | "in_progress" | "completed";
  order: number;
}

export interface IResponse {
  _id: string;
  formId: string;
  // Sprint 12, BE 0.3 (B8.1): immutable, per-form sequential reference (e.g. "#142"). Optional
  // only for responses predating this field and not yet backfilled.
  reference?: string;
  answers: Record<string, any> | IAnswer[];
  stageId?: string;
  stage?: IResponseStageSummary | null;
  // DEPRECATED: derived from stage.category, kept for pre-Sprint-12 consumers. See models/Response.ts.
  status?: "new" | "in_progress" | "completed" | string;
  submittedAt?: Date | string;
  ipHash?: string;
  response_files?: IResponseFile[];
  tagIds?: string[];
  assigneeId?: string | null;
  // Per calling user (Sprint 12, BE 0.2 / B8.2). Absence of a ResponseReadState row = unread.
  unread?: boolean;
  // Sprint 12, BE 0.6 (B4.10/B8.3): id of the earlier response this one duplicates, or null.
  // Flag only — never merged or dropped. See duplicate.service.ts for the OQ-6 assumption.
  duplicateOfId?: string | null;
  // Sprint 12, BE 0.3 (B5.x): live count, never cached — recomputed on every list/detail read.
  noteCount?: number;
  // Sprint 12, BE 0.5 (B6.1): pooled mean across every reviewer's ScoreEntry rows for every
  // criterion (never averaged-per-criterion-then-averaged), and the count of distinct reviewers
  // who have scored (not row count). Null/0 when nobody has scored yet.
  scoreAverage?: number | null;
  scoreCount?: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface PaginatedResponsesResult {
  data: IResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface UpdateResponseStatusInput {
  status: "new" | "in_progress" | "completed";
}
