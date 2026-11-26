import { z, ZodError } from "zod";

// Query schemas of the super admin content lists (templates, forms, exports) and of the new filters on logs and audit. Bad input is
// answered with 422 { success: false, message } by the controllers. An empty value ("?search=") counts as not given. Dates are UTC:
// "YYYY-MM-DD" (the whole day) or a full ISO timestamp (only its day is used); the end day is inclusive.

const blank = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blank, schema.optional());

const lenientInt = z.preprocess((v) => (v === undefined || v === "" ? undefined : Number(v) || undefined), z.number().int().optional());
const text = opt(z.string().trim().max(200));

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "Use a date like 2026-11-21")
  .refine((v) => !Number.isNaN(new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v).getTime()), "Not a real date");

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfUtcDay = (v: string) => {
  const d = new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/** { $gte: start of the first day, $lte: last millisecond of the last day }, or undefined when neither is given. */
export function dayRange(from?: string, to?: string): { $gte?: Date; $lte?: Date } | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { $gte: startOfUtcDay(from) } : {}),
    ...(to ? { $lte: new Date(startOfUtcDay(to).getTime() + DAY_MS - 1) } : {}),
  };
}

const orderedDays = (v: { from?: string; to?: string }) => !v.from || !v.to || startOfUtcDay(v.from) <= startOfUtcDay(v.to);
const ORDERED = { message: "`from` must not be after `to`.", path: ["from"] };

const order = opt(z.enum(["asc", "desc"]));
const paging = { page: lenientInt, limit: lenientInt, search: text };

export const TEMPLATE_SORTS = ["name", "category", "forms", "updated", "fields", "featured"] as const;
export const templatesQuerySchema = z.object({
  ...paging,
  category: text,
  status: opt(z.enum(["all", "active", "hidden"])),
  sort: opt(z.enum(TEMPLATE_SORTS)),
  order,
});

export const FORM_SORTS = ["title", "workspace", "owner", "status", "responses", "created", "updated"] as const;
export const formsQuerySchema = z
  .object({
    ...paging,
    status: opt(z.enum(["all", "draft", "published", "closed"])),
    workspace: text,
    owner: text,
    createdFrom: opt(day),
    createdTo: opt(day),
    sort: opt(z.enum(FORM_SORTS)),
    order,
  })
  .refine((v) => orderedDays({ from: v.createdFrom, to: v.createdTo }), { message: "`createdFrom` must not be after `createdTo`.", path: ["createdFrom"] });

export const exportsQuerySchema = z
  .object({
    page: lenientInt,
    limit: lenientInt,
    status: opt(z.string().trim().max(40)),
    format: opt(z.enum(["csv", "pdf"])),
    requester: text,
    from: opt(day),
    to: opt(day),
    order,
  })
  .refine(orderedDays, ORDERED);

/** An exact HTTP status ("400") or a class ("4xx"). */
export const logsStatusSchema = z.object({
  status: opt(z.string().trim().toLowerCase().regex(/^([1-5]\d\d|[2-5]xx)$/, "Use a status code like 400 or a class like 4xx")),
});

export const AUDIT_TARGET_TYPES = ["admin", "workspace", "form", "template", "session", "report", "server"] as const;
export const auditTargetSchema = z.object({ targetType: opt(z.enum(AUDIT_TARGET_TYPES)) });

/** One readable line for a 422 answer. */
export function zodMessage(error: ZodError): string {
  const i = error.issues[0];
  const path = i.path.join(".");
  return path ? `${path}: ${i.message}` : i.message;
}
