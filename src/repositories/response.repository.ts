import ResponseModel, { IResponse } from "../models/Response";
import mongoose from "mongoose";

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
    limit: number
  ): Promise<IResponse[]> {
    return await ResponseModel.find(query)
      .sort({ submittedAt: -1 })
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
      { $set: { status } },
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
      { $set: { stageId, status } },
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
