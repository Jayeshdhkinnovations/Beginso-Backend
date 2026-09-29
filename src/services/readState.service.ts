import mongoose from "mongoose";
import ResponseReadState from "../models/ResponseReadState";
import ResponseModel from "../models/Response";

// Per-user unread state (Sprint 12, BE 0.2 / B8.2). Absence of a row = unread; "mark unread" is a
// delete, never a boolean flip, so both endpoints are naturally idempotent.
export class ReadStateService {
  async markRead(userId: string, responseId: string): Promise<void> {
    await ResponseReadState.updateOne(
      { userId, responseId },
      { $set: { readAt: new Date() } },
      { upsert: true }
    );
  }

  async markUnread(userId: string, responseId: string): Promise<void> {
    await ResponseReadState.deleteOne({ userId, responseId });
  }

  async isUnread(userId: string, responseId: string): Promise<boolean> {
    const row = await ResponseReadState.exists({ userId, responseId });
    return !row;
  }

  // Batched for list endpoints: one query for the whole page instead of one per row.
  async unreadMap(userId: string, responseIds: (string | mongoose.Types.ObjectId)[]): Promise<Map<string, boolean>> {
    const map = new Map<string, boolean>();
    if (responseIds.length === 0) return map;
    const rows = await ResponseReadState.find({
      userId,
      responseId: { $in: responseIds },
    })
      .select("responseId")
      .lean();
    const readIds = new Set(rows.map((r) => r.responseId.toString()));
    for (const id of responseIds) {
      const key = id.toString();
      map.set(key, !readIds.has(key));
    }
    return map;
  }

  // Count of responses matching `matchQuery` with no read row for this user — the stats
  // endpoint's `unread` figure. A $lookup + empty-array match rather than fetching ids first,
  // since the caller (getResponseStats) never otherwise needs the matched ids themselves.
  async countUnread(userId: string, matchQuery: Record<string, unknown>): Promise<number> {
    const result = await ResponseModel.aggregate([
      { $match: matchQuery },
      {
        $lookup: {
          from: "responsereadstates",
          let: { rid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$responseId", "$$rid"] },
                    { $eq: ["$userId", new mongoose.Types.ObjectId(userId)] },
                  ],
                },
              },
            },
          ],
          as: "readState",
        },
      },
      { $match: { readState: { $size: 0 } } },
      { $count: "count" },
    ]);
    return result[0]?.count ?? 0;
  }

  // Migration helper (backfillReadState.ts): marks every response in `responseIds` as read for
  // every given user, in bulk. Idempotent via upsert.
  async markReadForUsersBulk(userIds: mongoose.Types.ObjectId[], responseId: mongoose.Types.ObjectId, readAt: Date): Promise<void> {
    if (userIds.length === 0) return;
    await ResponseReadState.bulkWrite(
      userIds.map((userId) => ({
        updateOne: {
          filter: { userId, responseId },
          update: { $setOnInsert: { userId, responseId, readAt } },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }
}
