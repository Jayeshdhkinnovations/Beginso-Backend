import { z } from "zod";

const metric = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const title = z.string().max(80).optional();

const config = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("kpi"),
      variant: z.number().int().min(1).max(20),
      metric,
      title,
      tone: z.enum(["primary", "success", "warning", "error", "purple"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("chart"),
      chart: z.enum(["bar", "line", "area", "hbar", "donut", "pie", "status"]),
      metric,
      title,
    })
    .strict(),
]);

const widget = z
  .object({
    id: z.string().min(1).max(64),
    w: z.union([z.literal(3), z.literal(4), z.literal(6)]),
    config,
  })
  .strict();

export const putDashboardSchema = z
  .object({
    widgets: z.array(widget).max(40),
    version: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((v) => new Set(v.widgets.map((w) => w.id)).size === v.widgets.length, {
    message: "Widget ids must be unique",
    path: ["widgets"],
  });
