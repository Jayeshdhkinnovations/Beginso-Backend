import { z } from "zod";

// Query of the super admin metrics endpoints. Dates are UTC: "YYYY-MM-DD" (the whole day) or a full ISO timestamp (only its day is
// used). The range is inclusive of the end day. Default: the last 30 days ending today.

const dayOrIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "Use a date like 2026-11-21")
  .refine((v) => !Number.isNaN(new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v).getTime()), "Not a real date");

const flag = z
  .enum(["1", "0", "true", "false"])
  .transform((v) => v === "1" || v === "true");

export const metricsQuerySchema = z
  .object({
    from: dayOrIso.optional(),
    to: dayOrIso.optional(),
    /** Compare with the previous period of the same length. Default true. */
    compare: flag.optional(),
    /** Skip the 60 second cache and recompute. */
    refresh: flag.optional(),
  })
  .strict();

export type MetricsQuery = z.infer<typeof metricsQuerySchema>;
