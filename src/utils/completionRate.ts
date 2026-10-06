import mongoose from "mongoose";
import ResponseModel from "../models/Response";

// Sprint 14 (B1.1, OQ-3, F15). ONE meaning for `completionRate` on every endpoint: counted submissions
// divided by counted views, 0-100, `null` when there are no counted views (never a made-up 0).
//   - views: Form.viewsCount, which the public view beacon increments once per IP per hour and never for
//     preview loads (`?preview=1`) or a form that is not open.
//   - submissions: lifetime, non-deleted, non-test responses (the Response query hooks drop `isTest`).
// The old stage-based figure (completed / total) is now `reviewedRate` everywhere it used to be returned.
export const computeCompletionRate = (submissions: number, views: number | null | undefined): number | null =>
  typeof views === "number" && views > 0 ? Math.min(100, Number(((submissions / views) * 100).toFixed(2))) : null;

// ponytail: one indexed grouped query per page of forms (<= 50) instead of a stored counter that has to be
// kept in step with deletes/restores. Add Form.submissionsCount only if this shows up in the load test.
export const lifetimeSubmissionCounts = async (formIds: Array<mongoose.Types.ObjectId | string>): Promise<Map<string, number>> => {
  if (formIds.length === 0) return new Map();
  const rows = await ResponseModel.aggregate([
    { $match: { formId: { $in: formIds.map((id) => new mongoose.Types.ObjectId(String(id))) }, deletedAt: null } },
    { $group: { _id: "$formId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count as number]));
};
