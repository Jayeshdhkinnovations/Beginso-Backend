import { z } from "zod";

export const createSavedViewSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(60),
  visibility: z.enum(["personal", "team"]),
  formId: z.string().trim().min(1).nullable().optional(),
  filters: z.record(z.string(), z.any()).default({}),
  viewMode: z.enum(["table", "board", "calendar", "chart"]).default("table"),
});

export const updateSavedViewSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(60).optional(),
    visibility: z.enum(["personal", "team"]).optional(),
    filters: z.record(z.string(), z.any()).optional(),
    viewMode: z.enum(["table", "board", "calendar", "chart"]).optional(),
  })
  .refine((v) => Object.values(v).some((val) => val !== undefined), {
    message: "At least one field is required",
  });
