import { z } from "zod";

export const createCriterionSchema = z.object({
  label: z.string().trim().max(60).optional(),
});

export const updateCriterionSchema = z
  .object({
    label: z.string().trim().max(60).optional(),
  })
  .refine((v) => v.label !== undefined, { message: "label is required" });

export const reorderCriteriaSchema = z.object({
  orderedIds: z.array(z.string().trim().min(1)).min(1, "orderedIds must contain at least one id"),
});

export const scoreResponseSchema = z.object({
  criterionId: z.string().trim().min(1, "criterionId is required"),
  value: z
    .number({ error: "value must be a number" })
    .int("value must be an integer")
    .min(1, "value must be between 1 and 10")
    .max(10, "value must be between 1 and 10"),
});
