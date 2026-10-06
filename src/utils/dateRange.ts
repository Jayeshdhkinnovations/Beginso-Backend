// A date-only `to` ("2026-10-06") means "through the end of that day", not midnight at its start - otherwise
// every response submitted on the last day of a range silently drops out of the figures.
export const parseToDate = (raw: string): Date =>
  /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T23:59:59.999Z`) : new Date(raw);

// `from` / `to` query values ("all" or absent = unbounded, invalid dates are ignored) -> a submittedAt filter.
export const submittedAtRange = (from: unknown, to: unknown): Record<string, Date> | undefined => {
  const range: Record<string, Date> = {};
  if (typeof from === "string" && from && from !== "all") {
    const d = new Date(from);
    if (!isNaN(d.getTime())) range.$gte = d;
  }
  if (typeof to === "string" && to && to !== "all") {
    const d = parseToDate(to);
    if (!isNaN(d.getTime())) range.$lte = d;
  }
  return Object.keys(range).length ? range : undefined;
};
