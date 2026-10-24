import ResponseModel, { IResponse } from "../models/Response";
import mongoose from "mongoose";

// Letters ignore case and runs of digits compare as numbers ("9" before "10"), the way a person reads a column.
const SORT_COLLATION = { locale: "en", strength: 2, numericOrdering: true } as const;

export type ColumnSort = { by: "email"; dir: 1 | -1 } | { by: "answer"; answerKey: string; dir: 1 | -1 };

// Mongo sorts a missing value before any number when ascending, which is what puts never-placed cards on top.
export const BOARD_SORT = { boardRank: 1, submittedAt: -1, _id: -1 } as const;

export class ResponseRepository {
  async create(data: Partial<IResponse>): Promise<IResponse> {
    return await ResponseModel.create(data);
  }

  async findById(id: string): Promise<IResponse | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return await ResponseModel.findById(id);
  }

  async findWithPagination(
    query: any,
    skip: number,
    limit: number,
    // 1 = oldest first. Default is newest first. _id breaks ties so a page boundary never repeats or drops a row.
    submittedOrder: 1 | -1 = -1,
    // The Board's order: cards placed by hand by their rank, with the never-placed ones (no rank) above them, newest first.
    board = false,
    // Sort by a column other than the submission time: the respondent's email, or the answer to one question (stored under `answerKey`).
    columnSort?: ColumnSort
  ): Promise<IResponse[]> {
    if (columnSort && !board) {
      // The value to order by: the respondent's email, or the answer to one question. $getField takes the key literally, so a question
      // whose label contains a dot (or starts with $) sorts like any other. A blank value goes last whichever way it goes, and blanks
      // keep newest first among themselves.
      const value =
        columnSort.by === "email" ? "$respondentEmail" : { $getField: { field: { $literal: columnSort.answerKey }, input: "$answers" } };
      return await ResponseModel.aggregate([
        { $match: query },
        { $addFields: { __sortValue: { $ifNull: [value, ""] } } },
        { $addFields: { __blank: { $cond: [{ $eq: ["$__sortValue", ""] }, 1, 0] } } },
        { $sort: { __blank: 1, __sortValue: columnSort.dir, submittedAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: { __blank: 0, __sortValue: 0 } },
      ]).collation(SORT_COLLATION);
    }
    return await ResponseModel.find(query)
      .sort(board ? BOARD_SORT : { submittedAt: submittedOrder, _id: submittedOrder })
      .skip(skip)
      .limit(limit);
  }

  async count(query: any): Promise<number> {
    return await ResponseModel.countDocuments(query);
  }

  async getStatsByFormId(formId: mongoose.Types.ObjectId): Promise<{ total: number; new: number; in_progress: number; completed: number }> {
    const statsResult = await ResponseModel.aggregate([
      { $match: { formId, deletedAt: null } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    let newCount = 0;
    let inProgressCount = 0;
    let completedCount = 0;

    for (const item of statsResult) {
      if (item._id === "new") newCount = item.count;
      else if (item._id === "in_progress") inProgressCount = item.count;
      else if (item._id === "completed") completedCount = item.count;
    }

    const total = newCount + inProgressCount + completedCount;

    return {
      total,
      new: newCount,
      in_progress: inProgressCount,
      completed: completedCount,
    };
  }

  async updateStatus(id: string, status: "new" | "in_progress" | "completed"): Promise<IResponse | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return await ResponseModel.findByIdAndUpdate(
      id,
      { $set: { status }, $unset: { boardRank: "" } },
      { returnDocument: "after", runValidators: true }
    );
  }

  // Sprint 12: moves a response onto a stage and keeps the deprecated `status` field synced to
  // that stage's category in the same write, so every pre-Sprint-12 status consumer stays correct.
  async updateStage(
    id: string,
    stageId: mongoose.Types.ObjectId,
    status: "new" | "in_progress" | "completed"
  ): Promise<IResponse | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return await ResponseModel.findByIdAndUpdate(
      id,
      { $set: { stageId, status }, $unset: { boardRank: "" } },
      { returnDocument: "after", runValidators: true }
    );
  }

  // Raw {stageId, count} pairs; the service joins these against Stage docs for name/colour/order.
  async getStageCounts(query: any): Promise<Array<{ _id: mongoose.Types.ObjectId | null; count: number }>> {
    return await ResponseModel.aggregate([
      { $match: query },
      { $group: { _id: "$stageId", count: { $sum: 1 } } },
    ]);
  }

  async deleteById(id: string): Promise<IResponse | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return null;
    }
    return await ResponseModel.findByIdAndDelete(id);
  }

  async deleteMany(query: any): Promise<{ deletedCount?: number }> {
    return await ResponseModel.deleteMany(query);
  }
}
