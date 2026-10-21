import { buildAnswerKeyMap } from "./answerKeys";

export interface ResponseSchemaField {
  fieldId: string;
  pageId?: string;
  type: string;
  label: string;
  options: string[];
  order: number;
  required: boolean;
}

export interface OrphanAnswer {
  key: string;
  label: string;
  value: any;
}

// Raw ids (24-hex, uuid, "f_...") are internal storage keys, never shown (same rule as cleanAnswers in response.service).
const ID_KEY = /^[0-9a-fA-F]{24}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$|^f_[a-zA-Z0-9_-]+$/;

// The form's live questions in form order, the answers keyed by fieldId, and the answers whose question is gone.
// A stored answer is found by its own key first, then by the legacy field-id / label keys (readFieldAnswer's rules), so
// two questions that share a label each get their own answer and old label-keyed responses still resolve.
// file_upload values are never copied: the stored value is an internal storage reference, and the files themselves
// are served through response_files.
export const buildResponseSchemaView = (
  form: { fields?: any[]; pages?: { id: string; order: number }[] } | null | undefined,
  rawAnswers: Record<string, any> | null | undefined
): { formSchema: { fields: ResponseSchemaField[] }; answersByFieldId: Record<string, any>; orphanAnswers: OrphanAnswer[] } => {
  const answers = rawAnswers && typeof rawAnswers === "object" ? rawAnswers : {};
  const fields = form?.fields ?? [];
  const keyMap = buildAnswerKeyMap(fields);
  const pageOrder = new Map((form?.pages ?? []).map((p) => [p.id, p.order]));

  const live = fields
    .filter((f) => !f.deleted)
    // Fields carry no stored order: position in the array is the order within a page (Array.sort is stable).
    .sort((a, b) => (pageOrder.get(a.pageId) ?? 0) - (pageOrder.get(b.pageId) ?? 0));

  const consumed = new Set<string>();
  const answersByFieldId: Record<string, any> = {};
  for (const f of live) {
    const own = keyMap.get(f) ?? f.label;
    const candidates = [own, f.fieldId, f._id ? String(f._id) : undefined, own === f.label ? f.label?.trim() : undefined];
    const hit = candidates.find((k) => k !== undefined && answers[k] !== undefined);
    candidates.forEach((k) => k !== undefined && answers[k] !== undefined && consumed.add(k));
    if (hit !== undefined && f.type !== "file_upload") answersByFieldId[f.fieldId] = answers[hit];
  }

  const orphanAnswers: OrphanAnswer[] = Object.entries(answers)
    .filter(([key]) => !consumed.has(key) && !ID_KEY.test(key))
    .map(([key, value]) => ({ key, label: key, value }));

  return {
    formSchema: {
      fields: live.map((f, i) => ({
        fieldId: f.fieldId,
        pageId: f.pageId,
        type: f.type,
        label: f.label,
        options: Array.from(f.options ?? []),
        order: i,
        required: !!f.required,
      })),
    },
    answersByFieldId,
    orphanAnswers,
  };
};
