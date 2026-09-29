import { z } from "zod";

// Max responses a single bulk request may touch. Over this, the request is refused (413) rather
// than silently truncated to the cap.
export const MAX_BULK_BATCH_SIZE = 500;

const idsTargetSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1, "ids must contain at least one id"),
});

const filterTargetSchema = z.object({
  filter: z.record(z.string(), z.any()).default({}),
  formId: z.string().trim().min(1).optional(),
});

export const bulkTargetSchema = z.union([idsTargetSchema, filterTargetSchema]);

export const bulkActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), stageId: z.string().trim().min(1) }),
  z.object({ type: z.literal("assign"), assigneeId: z.string().trim().min(1).nullable() }),
  z.object({ type: z.literal("tag"), tagId: z.string().trim().min(1) }),
  z.object({ type: z.literal("untag"), tagId: z.string().trim().min(1) }),
  z.object({ type: z.literal("read") }),
  z.object({ type: z.literal("unread") }),
  z.object({ type: z.literal("delete") }),
  z.object({ type: z.literal("restore") }),
]);

export const bulkRequestSchema = z.object({
  target: bulkTargetSchema,
  action: bulkActionSchema,
});

export type BulkTarget = z.infer<typeof bulkTargetSchema>;
export type BulkAction = z.infer<typeof bulkActionSchema>;
