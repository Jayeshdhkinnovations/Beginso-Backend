import mongoose from "mongoose";
import ScoreCriterionModel, { IScoreCriterion } from "../models/ScoreCriterion";
import ScoreEntryModel from "../models/ScoreEntry";
import ResponseModel from "../models/Response";
import Form from "../models/Form";

// Sprint 12, BE 0.5 (B6.1, OQ-7 resolved 3 Oct 2026). Same shape/conventions as stage.service.ts:
// default-seeding, ordering, notFound/conflict/badRequest helpers.

const notFound = (message: string): never => {
  const err: any = new Error(message);
  err.statusCode = 404;
  throw err;
};

const conflict = (message: string, code: string): never => {
  const err: any = new Error(message);
  err.statusCode = 409;
  err.code = code;
  throw err;
};

const badRequest = (message: string): never => {
  const err: any = new Error(message);
  err.statusCode = 400;
  throw err;
};

export interface ScoreAggregate {
  scoreAverage: number | null;
  scoreCount: number;
}

export class ScoreService {
  // Idempotent, mirrors stageService.ensureDefaultStages: only seeds when the workspace has zero
  // criteria yet, so calling this on every read is cheap and safe. Scoring must work with zero
  // manual setup (must-guarantee from tasks.md BE 0.5).
  async ensureDefaultCriteria(workspaceId: string): Promise<IScoreCriterion[]> {
    const existing = await ScoreCriterionModel.find({ workspaceId }).sort({ order: 1 });
    if (existing.length > 0) return existing;

    const seeded = await ScoreCriterionModel.create({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      label: "",
      order: 0,
      isDefault: true,
    });
    return [seeded];
  }

  async listCriteria(workspaceId: string): Promise<IScoreCriterion[]> {
    return await this.ensureDefaultCriteria(workspaceId);
  }

  async createCriterion(workspaceId: string, data: { label?: string }): Promise<IScoreCriterion> {
    await this.ensureDefaultCriteria(workspaceId);
    const last = await ScoreCriterionModel.findOne({ workspaceId }).sort({ order: -1 }).select("order").lean();
    const nextOrder = last ? last.order + 1 : 0;

    return await ScoreCriterionModel.create({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      label: data.label || "",
      order: nextOrder,
      isDefault: false,
    });
  }

  async updateCriterion(
    workspaceId: string,
    criterionId: string,
    data: { label?: string }
  ): Promise<IScoreCriterion> {
    if (!mongoose.Types.ObjectId.isValid(criterionId)) notFound("Criterion not found");
    const criterion = await ScoreCriterionModel.findOne({ _id: criterionId, workspaceId });
    if (!criterion) notFound("Criterion not found");

    if (data.label !== undefined) criterion!.label = data.label;
    await criterion!.save();
    return criterion!;
  }

  async reorderCriteria(workspaceId: string, orderedIds: string[]): Promise<IScoreCriterion[]> {
    const criteria = await ScoreCriterionModel.find({ workspaceId }).select("_id");
    const knownIds = new Set(criteria.map((c) => c._id.toString()));

    if (orderedIds.length !== knownIds.size || orderedIds.some((id) => !knownIds.has(id))) {
      badRequest("orderedIds must contain exactly the workspace's current criterion ids");
    }

    await ScoreCriterionModel.bulkWrite(
      orderedIds.map((id, index) => ({
        updateOne: { filter: { _id: id, workspaceId }, update: { $set: { order: index } } },
      }))
    );

    return await ScoreCriterionModel.find({ workspaceId }).sort({ order: 1 });
  }

  async deleteCriterion(workspaceId: string, criterionId: string): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(criterionId)) notFound("Criterion not found");
    const criterion = await ScoreCriterionModel.findOne({ _id: criterionId, workspaceId });
    if (!criterion) notFound("Criterion not found");

    if (criterion!.isDefault) {
      conflict("Cannot delete the default criterion", "CANNOT_DELETE_DEFAULT_CRITERION");
    }

    const siblingCount = await ScoreCriterionModel.countDocuments({
      workspaceId,
      _id: { $ne: criterion!._id },
    });
    if (siblingCount === 0) {
      conflict("Cannot delete the last remaining criterion", "CANNOT_DELETE_LAST_CRITERION");
    }

    // Existing ScoreEntry rows for this criterion are left as historical data (never deleted) —
    // the aggregate pools every ScoreEntry regardless of whether its criterion still exists, same
    // as a stage delete leaves past stage-change events intact.
    await ScoreCriterionModel.deleteOne({ _id: criterion!._id });
  }

  // Resolves and access-checks the response's form, mirroring note.service.ts's resolveResponse.
  async resolveResponseForm(responseId: string): Promise<{ response: any; form: any; workspaceId: string | null }> {
    if (!mongoose.Types.ObjectId.isValid(responseId)) notFound("Response not found");
    const response = await ResponseModel.findById(responseId);
    if (!response || response.deletedAt) notFound("Response not found");

    const form = await Form.findById(response!.formId);
    if (!form) notFound("Response not found");

    return { response: response!, form, workspaceId: form!.workspaceId ? form!.workspaceId.toString() : null };
  }

  // Upserts the caller's own row only, for this (response, criterion) pair — never touches any
  // other reviewer's row, per B6.1.
  async upsertScore(
    responseId: string,
    reviewerMembershipId: string,
    criterionId: string,
    value: number
  ): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(criterionId)) notFound("Criterion not found");
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      badRequest("value must be an integer between 1 and 10");
    }

    await ScoreEntryModel.updateOne(
      {
        responseId: new mongoose.Types.ObjectId(responseId),
        reviewerMembershipId: new mongoose.Types.ObjectId(reviewerMembershipId),
        criterionId: new mongoose.Types.ObjectId(criterionId),
      },
      { $set: { value } },
      { upsert: true }
    );
  }

  // Pooled mean across every reviewer's rows for every criterion (not per-criterion averaged) —
  // scoreCount is the number of DISTINCT reviewers who have scored, not the row count.
  async aggregateFor(responseId: string): Promise<ScoreAggregate> {
    const map = await this.aggregateForMany([responseId]);
    return map.get(responseId) || { scoreAverage: null, scoreCount: 0 };
  }

  // Batched aggregate for a page of responses — same one-query-per-page pattern noteService uses
  // for noteCount, never N+1.
  async aggregateForMany(responseIds: string[]): Promise<Map<string, ScoreAggregate>> {
    const map = new Map<string, ScoreAggregate>();
    if (responseIds.length === 0) return map;

    const agg = await ScoreEntryModel.aggregate([
      { $match: { responseId: { $in: responseIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
      {
        $group: {
          _id: "$responseId",
          sum: { $sum: "$value" },
          count: { $sum: 1 },
          reviewers: { $addToSet: "$reviewerMembershipId" },
        },
      },
    ]);

    for (const row of agg) {
      map.set(row._id.toString(), {
        scoreAverage: row.count > 0 ? row.sum / row.count : null,
        scoreCount: (row.reviewers || []).length,
      });
    }
    return map;
  }

  async myRows(responseId: string, reviewerMembershipId: string): Promise<Array<{ criterionId: string; value: number }>> {
    const rows = await ScoreEntryModel.find({ responseId, reviewerMembershipId }).lean();
    return rows.map((r) => ({ criterionId: r.criterionId.toString(), value: r.value }));
  }
}
