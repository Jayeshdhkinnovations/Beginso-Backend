import { z } from "zod";

// Query of GET /api/superadmin/server/containers/:name/logs. Strict: an unknown key is a 422. An empty value counts as not given.
// tail 1..1000 lines (default 100); since is the window in seconds, 60..86400 (default 3600, never more than 24 hours); search is a plain
// case-insensitive substring of at most 100 characters (it is never turned into a regular expression); level is a comma list.

const blank = (v: unknown) => (v === "" ? undefined : v);

export const LOG_LEVELS = ["info", "warn", "error", "unknown"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const int = (min: number, max: number, fallback: number) =>
  z.preprocess(blank, z.coerce.number().int().min(min).max(max).default(fallback));

export const logsQuerySchema = z.strictObject({
  tail: int(1, 1000, 100),
  since: int(60, 86400, 3600),
  search: z.preprocess(blank, z.string().max(100).optional()),
  level: z.preprocess(
    blank,
    z
      .string()
      .max(60)
      .transform((v) => v.split(",").map((s) => s.trim().toLowerCase()))
      .pipe(z.array(z.enum(LOG_LEVELS)).min(1))
      .transform((v) => [...new Set(v)])
      .optional(),
  ),
});

export type LogsQuery = z.infer<typeof logsQuerySchema>;
