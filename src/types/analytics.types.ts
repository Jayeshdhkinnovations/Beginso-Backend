export interface IStatusCount {
  status: "completed" | "in_progress" | "new";
  count: number;
  percentage: number;
}

// Sprint 12: per-stage breakdown alongside the legacy statusDistribution. Omits stages with zero
// responses that never got a stageId (pre-migration data).
export interface IStageCount {
  stageId: string;
  name: string;
  colour: string;
  category: "completed" | "in_progress" | "new";
  count: number;
  percentage: number;
}

export interface IAnalyticsOverviewData {
  formId: string;
  total: number;
  completed: number;
  in_progress: number;
  new: number;
  // Sprint 14: submissions / views (0-100), null when the form has no counted views.
  completionRate: number | null;
  // Sprint 14: the previous stage-based figure (completed / total).
  reviewedRate: number;
  views: number | null;
  statusDistribution: IStatusCount[];
  stageDistribution: IStageCount[];
  dateRange: {
    from: string | null;
    to: string | null;
    timezone: string;
  };
}

export interface AnalyticsOverviewResponse {
  success: boolean;
  data: IAnalyticsOverviewData;
}

export interface IQuestionSummaryOption {
  label: string;
  count: number;
  percentage: number;
}

export interface IQuestionSummaryText {
  sampleAnswers: string[];
}

export interface IQuestionAnalytics {
  fieldId: string;
  label: string;
  type: string;
  totalAnswered: number;
  responseRate: number;
  summary: {
    options?: IQuestionSummaryOption[];
    text?: IQuestionSummaryText;
  };
}

export interface IAnalyticsQuestionsData {
  formId: string;
  totalResponses: number;
  questions: IQuestionAnalytics[];
  dateRange: {
    from: string | null;
    to: string | null;
    timezone: string;
  };
}

export interface AnalyticsQuestionsResponse {
  success: boolean;
  data: IAnalyticsQuestionsData;
}

export interface ITrendPoint {
  bucketStart: string;
  responses: number;
}

export interface AnalyticsTrendsResponse {
  success: boolean;
  points: ITrendPoint[];
  dateRange?: {
    from: string | null;
    to: string | null;
    timezone: string;
    bucket: "day" | "week";
  };
}

export interface IFormSummaryRow {
  formId: string;
  title: string;
  status: string;
  totalResponses: number;
  completionRate: number | null;
  reviewedRate: number;
  views: number | null;
  templateCategory: string | null;
  templateId: string | null;
  sparkline: number[];
  updatedAt: string | Date;
}

export interface AnalyticsFormsSummaryResponse {
  success: boolean;
  data: IFormSummaryRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
