import { z } from "zod";

// Sprint 12, BE 0.3 (B5.1). mentionIds is trusted only as "a list of candidate ids the client's
// picker produced" — note.service.ts independently re-validates each one against the response's
// form before anything is written or notified.
export const noteBodySchema = z.object({
  body: z.string().trim().min(1, "body must be 1-5000 characters").max(5000, "body must be 1-5000 characters"),
  mentionIds: z.array(z.string().trim().min(1)).optional(),
});
