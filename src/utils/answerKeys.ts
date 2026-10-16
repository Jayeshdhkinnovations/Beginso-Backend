// Answers are stored in a map keyed by the question's label (the readers, exports and charts all depend on that).
// Two questions with the same label used to share one key, so the second answer silently replaced the first
// (QA D5-001). Every question now gets its own key: the label for the first one, "Label (2)", "Label (3)" for the
// next ones with the same label - the same names the CSV export already uses for its columns.
//
// Existing data is untouched: a form without duplicate labels maps every question to its own label, as before.
// A form that already holds overwritten answers cannot be repaired (the first answer was never stored).

export interface KeyedField {
  label?: string;
  deleted?: boolean;
}

/** field -> storage key, for the fields of ONE form. Deleted fields keep their plain label (they are never written). */
export const buildAnswerKeyMap = <F extends KeyedField>(fields: F[] | undefined): Map<F, string> => {
  const map = new Map<F, string>();
  const list = fields ?? [];
  const taken = new Set<string>(list.map((f) => (f.label ?? "").trim() || "Untitled question"));
  const used = new Set<string>();
  for (const f of list) {
    const base = (f.label ?? "").trim() || "Untitled question";
    if (f.deleted) {
      map.set(f, f.label ?? base);
      continue;
    }
    let key = f.label ?? base;
    if (used.has(key)) {
      let n = 2;
      while (used.has(`${base} (${n})`) || taken.has(`${base} (${n})`)) n++;
      key = `${base} (${n})`;
    }
    used.add(key);
    map.set(f, key);
  }
  return map;
};

/** The set of keys a submission may write: one per active question. */
export const activeAnswerKeys = <F extends KeyedField>(fields: F[] | undefined, map = buildAnswerKeyMap(fields)): Set<string> =>
  new Set((fields ?? []).filter((f) => !f.deleted).map((f) => map.get(f) as string));

/** The stored answer for one question: its own key first, then (only for the first holder of a label) legacy keys. */
export const readFieldAnswer = (
  answers: Record<string, any> | undefined,
  field: KeyedField & { fieldId?: string; _id?: any },
  map: Map<any, string>
): any => {
  if (!answers || typeof answers !== "object") return undefined;
  const key = map.get(field) ?? field.label;
  if (key !== undefined && answers[key] !== undefined) return answers[key];
  const isFirstHolder = key === field.label;
  // Old data is keyed by field id; a second question that shares a label must not borrow the first one's value.
  if (field.fieldId && answers[field.fieldId] !== undefined) return answers[field.fieldId];
  if (field._id && answers[String(field._id)] !== undefined) return answers[String(field._id)];
  if (isFirstHolder && field.label && answers[field.label.trim()] !== undefined) return answers[field.label.trim()];
  return undefined;
};

/** The storage key of one question, found by identity or field id (works with plain objects and Mongoose subdocuments). */
export const answerKeyOf = <F extends KeyedField & { fieldId?: string }>(fields: F[] | undefined, field: F): string => {
  const list = fields ?? [];
  const map = buildAnswerKeyMap(list);
  const hit = list.find((f) => f === field || (!!f.fieldId && f.fieldId === field.fieldId));
  return (hit && map.get(hit)) || field.label || "";
};
