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
  answers: Record<string, any> | IAnswer[];
  stageId?: string;
  stage?: IResponseStageSummary | null;
  // DEPRECATED: derived from stage.category, kept for pre-Sprint-12 consumers. See models/Response.ts.
  status?: "new" | "in_progress" | "completed" | string;
  submittedAt?: Date | string;
  ipHash?: string;
  response_files?: IResponseFile[];
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
