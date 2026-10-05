import mongoose from "mongoose";
import StageModel, { IStage, StageCategory } from "../models/Stage";
import ResponseModel from "../models/Response";
import { Event } from "../models/Event";

export interface StageActor {
  id: any;
  email: string;
  name: string;
}

// Seeded whenever a workspace has zero stages (new workspace, or one that predates Sprint 12).
// category values double as the legacy Response.status values, so mapping between the two is a
// straight lookup, not a translation table.
export const DEFAULT_STAGE_SEEDS: Array<{ name: string; colour: string; category: StageCategory; isDefault: boolean; order: number }> = [
  { name: "New", colour: "slate", category: "new", isDefault: true, order: 0 },
  { name: "In Progress", colour: "amber", category: "in_progress", isDefault: false, order: 1 },
  { name: "Completed", colour: "emerald", category: "completed", isDefault: false, order: 2 },
];

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

export class StageService {
  // Every workspace must always have >=1 stage. Idempotent: only seeds when none exist yet, so
  // calling this on every GET is cheap and safe. `workspaceId` here is always a real workspace —
  // the personal shell never reaches this (see `updateResponseStage`'s own null-workspace branch);
  // `Stage.workspaceId` is a required field, so a personal/null "workspace" isn't representable
  // here at all.
  async ensureDefaultStages(workspaceId: string): Promise<IStage[]> {
    const existing = await StageModel.find({ workspaceId }).sort({ order: 1 });
    if (existing.length > 0) return existing;

    const seeded = await StageModel.insertMany(
      DEFAULT_STAGE_SEEDS.map((s) => ({ ...s, workspaceId: new mongoose.Types.ObjectId(workspaceId) }))
    );
    return seeded.sort((a, b) => a.order - b.order) as unknown as IStage[];
  }

  async listStages(workspaceId: string): Promise<IStage[]> {
    return await this.ensureDefaultStages(workspaceId);
  }

  // Resolves a stage by id, scoped to the workspace. Used by response-stage-change endpoints.
  async getStageInWorkspace(workspaceId: string, stageId: string): Promise<IStage> {
    if (!mongoose.Types.ObjectId.isValid(stageId)) notFound("Stage not found");
    const stage = await StageModel.findOne({ _id: stageId, workspaceId });
    if (!stage) notFound("Stage not found");
    return stage!;
  }

  // Legacy-status compatibility: a caller sending {status} instead of {stageId} still needs to
  // land on *some* stage of the matching category, preferring the workspace's default stage when
  // its category matches (usually "new").
  async resolveStageForCategory(workspaceId: string, category: StageCategory): Promise<IStage> {
    const stages = await this.ensureDefaultStages(workspaceId);
    const match =
      stages.find((s) => s.category === category && s.isDefault) ||
      stages.find((s) => s.category === category);
    if (!match) notFound(`No stage exists for category '${category}'`);
    return match!;
  }

  async createStage(
    workspaceId: string,
    data: { name: string; colour: string; category: StageCategory }
  ): Promise<IStage> {
    await this.ensureDefaultStages(workspaceId);
    const last = await StageModel.findOne({ workspaceId }).sort({ order: -1 }).select("order").lean();
    const nextOrder = last ? last.order + 1 : 0;

    return await StageModel.create({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      name: data.name,
      colour: data.colour,
      category: data.category,
      isDefault: false,
      order: nextOrder,
    });
  }

  async updateStage(
    workspaceId: string,
    stageId: string,
    data: { name?: string; colour?: string; category?: StageCategory }
  ): Promise<IStage> {
    if (!mongoose.Types.ObjectId.isValid(stageId)) notFound("Stage not found");
    const stage = await StageModel.findOne({ _id: stageId, workspaceId });
    if (!stage) notFound("Stage not found");

    const categoryChanged = data.category !== undefined && data.category !== stage!.category;

    if (data.name !== undefined) stage!.name = data.name;
    if (data.colour !== undefined) stage!.colour = data.colour;
    if (data.category !== undefined) stage!.category = data.category;
    await stage!.save();

    // The stage's category is what Response.status is derived from: every response currently on
    // this stage must be re-synced so status never drifts from the stage it actually belongs to.
    if (categoryChanged) {
      await ResponseModel.updateMany({ stageId: stage!._id }, { $set: { status: stage!.category } });
    }

    return stage!;
  }

  async reorderStages(workspaceId: string, orderedIds: string[]): Promise<IStage[]> {
    const stages = await StageModel.find({ workspaceId }).select("_id");
    const knownIds = new Set(stages.map((s) => s._id.toString()));

    if (orderedIds.length !== knownIds.size || orderedIds.some((id) => !knownIds.has(id))) {
      badRequest("orderedIds must contain exactly the workspace's current stage ids");
    }

    await StageModel.bulkWrite(
      orderedIds.map((id, index) => ({
        updateOne: { filter: { _id: id, workspaceId }, update: { $set: { order: index } } },
      }))
    );

    return await StageModel.find({ workspaceId }).sort({ order: 1 });
  }

  async deleteStage(
    workspaceId: string,
    stageId: string,
    options: { reassignTo?: string; actor: StageActor; ip?: string }
  ): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(stageId)) notFound("Stage not found");
    const stage = await StageModel.findOne({ _id: stageId, workspaceId });
    if (!stage) notFound("Stage not found");

    if (stage!.isDefault) {
      conflict("Cannot delete the default stage", "CANNOT_DELETE_DEFAULT_STAGE");
    }

    const siblingsInCategory = await StageModel.countDocuments({
      workspaceId,
      category: stage!.category,
      _id: { $ne: stage!._id },
    });
    if (siblingsInCategory === 0) {
      conflict(
        `Cannot delete the last remaining '${stage!.category}' stage`,
        "CANNOT_DELETE_LAST_OF_CATEGORY"
      );
    }

    // includeTest: a test submission still sits on a stage, so deleting the stage must reassign it too.
    const responseCount = await ResponseModel.countDocuments({ stageId: stage!._id }).setOptions({ includeTest: true });

    let reassignStage: IStage | null = null;
    if (responseCount > 0) {
      if (!options.reassignTo) {
        badRequest("reassignTo is required: this stage has responses assigned to it");
      }
      if (!mongoose.Types.ObjectId.isValid(options.reassignTo!)) notFound("reassignTo stage not found");
      reassignStage = await StageModel.findOne({ _id: options.reassignTo, workspaceId });
      if (!reassignStage) notFound("reassignTo stage not found");
      if (reassignStage!._id.toString() === stage!._id.toString()) {
        badRequest("reassignTo must be a different stage");
      }
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (responseCount > 0 && reassignStage) {
          const affected = await ResponseModel.find({ stageId: stage!._id })
            .setOptions({ includeTest: true })
            .select("_id")
            .session(session);

          await ResponseModel.updateMany(
            { stageId: stage!._id },
            { $set: { stageId: reassignStage._id, status: reassignStage.category } },
            { session }
          );

          if (affected.length > 0) {
            // One audit event per moved response (C3.6), not one summary event.
            await Event.insertMany(
              affected.map((r) => ({
                workspaceId: new mongoose.Types.ObjectId(workspaceId),
                actorId: options.actor.id,
                actorEmail: options.actor.email,
                actorName: options.actor.name || options.actor.email,
                action: "response.stage_change",
                targetId: r._id.toString(),
                targetType: "response",
                targetLabel: r._id.toString(),
                metadata: {
                  fromStageId: stage!._id.toString(),
                  toStageId: reassignStage._id.toString(),
                  reason: "stage_deleted",
                },
                ip: options.ip,
                createdAt: new Date(),
              })),
              { session, ordered: false }
            );
          }
        }

        await StageModel.deleteOne({ _id: stage!._id }, { session });
      });
    } finally {
      await session.endSession();
    }
  }
}
