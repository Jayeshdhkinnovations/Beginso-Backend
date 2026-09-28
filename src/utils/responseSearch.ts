// Flat, lower-cased text of a response's answer values, stored on the response so search runs in
// MongoDB instead of loading rows into Node and stringifying them.
export const buildSearchText = (answers: unknown): string => {
  const parts = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (value == null || depth > 4) return;
    if (typeof value === "string") parts.add(value);
    else if (typeof value === "number" || typeof value === "boolean") parts.add(String(value));
    else if (Array.isArray(value)) value.forEach((v) => walk(v, depth + 1));
    else if (typeof value === "object") {
      const file = value as { fileName?: unknown };
      if (typeof file.fileName === "string") parts.add(file.fileName);
      else Object.values(value as object).forEach((v) => walk(v, depth + 1));
    }
  };
  walk(answers, 0);
  // ponytail: capped at 20k chars per response; raise it if a form legitimately holds longer answers.
  return [...parts].join(" ").toLowerCase().slice(0, 20000);
};
