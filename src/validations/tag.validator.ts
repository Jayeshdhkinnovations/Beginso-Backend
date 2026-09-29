import { z } from "zod";

export const createTagSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(60),
  colour: z.string().trim().min(1, "colour is required").max(40),
});

export const updateTagSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(60).optional(),
    colour: z.string().trim().min(1, "colour is required").max(40).optional(),
  })
  .refine((v) => v.name !== undefined || v.colour !== undefined, {
    message: "At least one of name, colour is required",
  });

export const mergeTagSchema = z.object({
  into: z.string().trim().min(1, "into is required"),
});
