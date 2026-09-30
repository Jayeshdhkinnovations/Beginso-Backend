import { z } from "zod";

// stageId is the Sprint 12 way to change a response's place in the pipeline; status is kept for
// callers that have not migrated yet. At least one is required, and if both are sent stageId wins
// (see ResponseService.updateResponseStage) — its stage's category is what determines status.
export const updateResponseStatusSchema = z
  .object({
    status: z
      .enum(["new", "in_progress", "completed"], {
        error: "status must be one of 'new', 'in_progress', or 'completed'",
      })
      .optional(),
    stageId: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.status !== undefined || v.stageId !== undefined, {
    message: "Either status or stageId is required",
  });

// Sprint 12, BE 0.2 (B3.2/R4): assigneeId is validated separately from status/stageId so a PATCH
// can carry either or both in the same request. `null` unassigns; a string id must resolve to a
// current member with access to the response's form (checked in ResponseService).
export const updateResponseAssigneeSchema = z.object({
  assigneeId: z.string().trim().min(1).nullable(),
});

// Bug fix, Sprint 12 close-out: `PATCH /api/responses/:id` had no branch for `tagIds` at all —
// the frontend's TagPicker sends the response's full desired tag list (add/remove computed
// client-side), which fell through to `updateResponseStatusSchema`'s "status or stageId required"
// refinement and 422'd on every tag change. Same independent-field pattern as assigneeId above.
export const updateResponseTagsSchema = z.object({
  tagIds: z.array(z.string().trim().min(1)),
});
