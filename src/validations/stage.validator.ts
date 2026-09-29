import { z } from "zod";

const stageCategoryEnum = z.enum(["new", "in_progress", "completed"], {
  error: "category must be one of 'new', 'in_progress', or 'completed'",
});

export const createStageSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(60),
  colour: z.string().trim().min(1, "colour is required").max(40),
  category: stageCategoryEnum,
});

export const updateStageSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(60).optional(),
    colour: z.string().trim().min(1, "colour is required").max(40).optional(),
    category: stageCategoryEnum.optional(),
  })
  .refine((v) => v.name !== undefined || v.colour !== undefined || v.category !== undefined, {
    message: "At least one of name, colour, category is required",
  });

export const deleteStageSchema = z.object({
  reassignTo: z.string().trim().min(1).optional(),
});

export const reorderStagesSchema = z.object({
  orderedIds: z.array(z.string().trim().min(1)).min(1, "orderedIds must contain at least one id"),
});
