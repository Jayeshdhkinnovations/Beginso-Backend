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
    const existing = await StageModel.find({ workspaceId, formId: null }).sort({ order: 1 });
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
    const last = await StageModel.findOne({ workspaceId, formId: null }).sort({ order: -1 }).select("order").lean();
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
    const stage = await StageModel.findOne({ _id: stageId, workspaceId, formId: null });
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
    const stages = await StageModel.find({ workspaceId, formId: null }).select("_id");
    const knownIds = new Set(stages.map((s) => s._id.toString()));

    if (orderedIds.length !== knownIds.size || orderedIds.some((id) => !knownIds.has(id))) {
      badRequest("orderedIds must contain exactly the workspace's current stage ids");
    }

    await StageModel.bulkWrite(
      orderedIds.map((id, index) => ({
        updateOne: { filter: { _id: id, workspaceId, formId: null }, update: { $set: { order: index } } },
      }))
    );

    return await StageModel.find({ workspaceId, formId: null }).sort({ order: 1 });
  }

  async deleteStage(
    workspaceId: string,
    stageId: string,
    options: { reassignTo?: string; actor: StageActor; ip?: string }
  ): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(stageId)) notFound("Stage not found");
    const stage = await StageModel.findOne({ _id: stageId, workspaceId, formId: null });
    if (!stage) notFound("Stage not found");

    if (stage!.isDefault) {
      conflict("Cannot delete the default stage", "CANNOT_DELETE_DEFAULT_STAGE");
    }

    const siblingsInCategory = await StageModel.countDocuments({
      workspaceId,
      formId: null,
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
      reassignStage = await StageModel.findOne({ _id: options.reassignTo, workspaceId, formId: null });
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
  // ── Per-form stages ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  // A form can have stages of its own (Stage.formId set). A form without any uses the workspace's. Responses always carry
  // `status` (the stage's category), so a stage change of either kind keeps every status-based consumer correct.

  async listFormStages(formId: string): Promise<IStage[]> {
    return await StageModel.find({ formId }).sort({ order: 1 });
  }

  /** The stages a form really uses: its own when it has any, else the workspace's. */
  async effectiveStages(workspaceId: string, formId: string): Promise<{ stages: IStage[]; own: boolean }> {
    const own = await this.listFormStages(formId);
    if (own.length > 0) return { stages: own, own: true };
    return { stages: await this.ensureDefaultStages(workspaceId), own: false };
  }

  /**
   * A stage a response of `formId` may be moved to: one of the form's own stages when it has any, else one of the workspace's.
   * Moving a response onto the other kind of stage would leave it in a column its form does not show.
   */
  async getStageForForm(workspaceId: string, formId: string, stageId: string): Promise<IStage> {
    const stage = await this.getStageInWorkspace(workspaceId, stageId);
    if (stage.formId) {
      if (String(stage.formId) !== String(formId)) badRequest("That stage belongs to another form");
    } else if (await StageModel.exists({ formId })) {
      badRequest("This form has its own stages: choose one of them");
    }
    return stage;
  }

  /** Legacy `{status}` writes: a stage of that category from the form's own stages when it has any, else the workspace's. */
  async resolveStageForForm(workspaceId: string, formId: string, category: StageCategory): Promise<IStage> {
    const own = await this.listFormStages(formId);
    if (own.length === 0) return await this.resolveStageForCategory(workspaceId, category);
    return own.find((s) => s.category === category) ?? own[0];
  }

  /** The stage a brand-new response of this form starts in. */
  async startStageForForm(workspaceId: string, formId: string, startStageId?: unknown): Promise<IStage | null> {
    const { stages, own } = await this.effectiveStages(workspaceId, formId);
    if (own && startStageId) {
      const chosen = stages.find((s) => String(s._id) === String(startStageId));
      if (chosen) return chosen;
    }
    return stages.find((s) => s.isDefault) ?? stages.find((s) => s.category === "new") ?? stages[0] ?? null;
  }

  /**
   * Makes the form's stages exactly `input`. `workspace` drops the form's own stages; `own` creates, updates (by id), reorders and
   * deletes so that the form has exactly the given list, in that order. Every response that is not on one of the resulting stages
   * (it was on a deleted stage, or on a workspace stage) moves to the first stage that counts the same way, else to the first stage.
   * Returns the stages the form uses afterwards.
   */
  async applyFormStages(
    workspaceId: string,
    formId: string,
    input: { mode: "workspace" } | { mode: "own"; stages: Array<{ id?: string; name: string; colour: string; category: StageCategory }> }
  ): Promise<IStage[]> {
    const existing = await StageModel.find({ formId });

    if (input.mode === "workspace") {
      const workspaceStages = await this.ensureDefaultStages(workspaceId);
      if (existing.length === 0) return workspaceStages;
      await this.moveFormResponses(formId, workspaceStages, []);
      await StageModel.deleteMany({ formId });
      return workspaceStages;
    }

    if (input.stages.length === 0) badRequest("A form needs at least one stage");
    const byId = new Map(existing.map((s) => [s._id.toString(), s]));
    for (const s of input.stages) {
      if (s.id && !byId.has(s.id)) badRequest("A stage in the list does not belong to this form");
    }

    const result: IStage[] = [];
    for (const [order, s] of input.stages.entries()) {
      const doc = s.id ? byId.get(s.id) : undefined;
      if (doc) {
        const categoryChanged = doc.category !== s.category;
        doc.name = s.name;
        doc.colour = s.colour;
        doc.category = s.category;
        doc.order = order;
        await doc.save();
        // Keep Response.status (derived from the stage's category) in step for responses already on it.
        if (categoryChanged) await ResponseModel.updateMany({ stageId: doc._id }, { $set: { status: s.category } });
        result.push(doc);
      } else {
        result.push(
          await StageModel.create({
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            formId: new mongoose.Types.ObjectId(formId),
            name: s.name,
            colour: s.colour,
            category: s.category,
            order,
            isDefault: false,
          })
        );
      }
    }

    await this.moveFormResponses(formId, result, result.map((s) => s._id as mongoose.Types.ObjectId));
    const keptIds = new Set(result.map((s) => s._id.toString()));
    const removed = existing.filter((s) => !keptIds.has(s._id.toString()));
    if (removed.length > 0) await StageModel.deleteMany({ _id: { $in: removed.map((s) => s._id) } });
    return result;
  }

  // Moves every response of the form that is NOT on one of `keepIds` onto a stage of `target`: the first that counts the same way
  // (by the response's `status`), else the first. One update for the whole form, deciding from the status each response had before.
  private async moveFormResponses(formId: string, target: IStage[], keepIds: mongoose.Types.ObjectId[]): Promise<void> {
    const categories: StageCategory[] = ["new", "in_progress", "completed"];
    const pick = (c: StageCategory) => target.find((s) => s.category === c) ?? target[0];
    await ResponseModel.updateMany(
      { formId: new mongoose.Types.ObjectId(formId), stageId: { $nin: keepIds } },
      [
        {
          $set: {
            stageId: { $switch: { branches: categories.map((c) => ({ case: { $eq: ["$status", c] }, then: pick(c)._id })), default: pick("new")._id } },
            status: { $switch: { branches: categories.map((c) => ({ case: { $eq: ["$status", c] }, then: pick(c).category })), default: pick("new").category } },
          },
        },
        { $unset: "boardRank" },
      ],
      { updatePipeline: true }
    );
  }
}
