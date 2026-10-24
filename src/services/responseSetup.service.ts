import mongoose from "mongoose";
import ResponseSetup, { DEFAULT_TABLE_COLUMNS, IResponseSetup, TABLE_BUILTIN_COLUMNS } from "../models/ResponseSetup";
import StageModel, { IStage } from "../models/Stage";
import { StageService } from "./stage.service";
import type { ResponseSetupInput } from "../validations/responseSetup.validator";

export const RESPONSE_SETUP_STALE = "RESPONSE_SETUP_STALE";

const stageService = new StageService();

const fail = (statusCode: number, message: string, code?: string): never => {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  throw err;
};

const staleError = (currentVersion?: number): Error => {
  const err: any = new Error("The setup of this form was changed by someone else. Reload it before saving again.");
  err.statusCode = 409;
  err.code = RESPONSE_SETUP_STALE;
  if (currentVersion !== undefined) err.currentVersion = currentVersion;
  return err;
};

/** What everybody sees until someone customises: today's table, today's board, today's order. */
export const DEFAULT_SETUP = {
  tableColumns: DEFAULT_TABLE_COLUMNS,
  cardTitle: "auto",
  opensAs: "table",
  sort: "newest",
  respondentFrom: "auto",
  rowHeight: "comfortable",
  wrap: false,
} as const;

interface FormLike {
  _id: mongoose.Types.ObjectId | string;
  workspaceId?: mongoose.Types.ObjectId | string | null;
  fields?: { fieldId?: string; deleted?: boolean }[];
}

const liveFieldIds = (form: FormLike): Set<string> => new Set((form.fields ?? []).filter((f) => !f.deleted && f.fieldId).map((f) => f.fieldId as string));

const toStageJson = (s: IStage) => ({ id: s._id.toString(), name: s.name, colour: s.colour, category: s.category, order: s.order, isDefault: s.isDefault });

/**
 * A reference to a question that has since been deleted is dropped when the setup is read (the table loses that column, the card
 * falls back to the respondent), so deleting a question never breaks a saved setup.
 */
const cleanSetup = (doc: Partial<IResponseSetup> | null, live: Set<string>) => {
  const base = { ...DEFAULT_SETUP, tableColumns: [...DEFAULT_SETUP.tableColumns] as string[] };
  if (!doc) return base;
  const columns = (doc.tableColumns ?? []).filter((k) => (TABLE_BUILTIN_COLUMNS as readonly string[]).includes(k) || (k.startsWith("q:") && live.has(k.slice(2))));
  return {
    tableColumns: columns.length > 0 ? columns : base.tableColumns,
    cardTitle: doc.cardTitle && (doc.cardTitle === "auto" || live.has(doc.cardTitle)) ? doc.cardTitle : "auto",
    opensAs: doc.opensAs ?? base.opensAs,
    sort: doc.sort ?? base.sort,
    respondentFrom: doc.respondentFrom && (doc.respondentFrom === "auto" || live.has(doc.respondentFrom)) ? doc.respondentFrom : "auto",
    rowHeight: doc.rowHeight ?? base.rowHeight,
    wrap: doc.wrap ?? base.wrap,
  };
};

/** GET: the form's setup (defaults filled in), the stages it really uses, and the version to send back when saving. */
export async function getResponseSetup(form: FormLike) {
  const formId = String(form._id);
  const doc = await ResponseSetup.findOne({ formId }).lean<IResponseSetup | null>();
  const workspaceId = form.workspaceId ? String(form.workspaceId) : null;
  const { stages, own } = workspaceId ? await stageService.effectiveStages(workspaceId, formId) : { stages: [] as IStage[], own: false };
  const startIndex = own && doc?.startStageId ? stages.findIndex((s) => String(s._id) === String(doc.startStageId)) : -1;
  return {
    version: doc?.version ?? 0,
    setup: cleanSetup(doc, liveFieldIds(form)),
    stages: {
      mode: own ? ("own" as const) : ("workspace" as const),
      list: stages.map(toStageJson),
      startIndex: startIndex >= 0 ? startIndex : own ? Math.max(0, stages.findIndex((s) => s.isDefault)) : null,
    },
  };
}

/** PUT: stages first (they may move responses), then the setup row, compare-and-swap on the version the editor loaded. */
export async function saveResponseSetup(form: FormLike, userId: string, input: ResponseSetupInput) {
  const formId = String(form._id);
  const workspaceId = form.workspaceId ? String(form.workspaceId) : null;

  if (input.stages.mode === "own" && !workspaceId) {
    fail(422, "Personal forms use the three standard stages. Move the form to a workspace to give it stages of its own.", "PERSONAL_FORM_STAGES");
  }

  const live = liveFieldIds(form);
  const unknown = [
    ...input.tableColumns.filter((k) => k.startsWith("q:") && !live.has(k.slice(2))),
    ...[input.cardTitle, input.respondentFrom].filter((k) => k !== "auto" && !live.has(k)),
  ];
  if (unknown.length > 0) fail(422, "A column or field refers to a question that is not on this form", "UNKNOWN_QUESTION");

  const current = await ResponseSetup.findOne({ formId }).select("version").lean<{ version: number } | null>();
  if ((current?.version ?? 0) !== input.version) throw staleError(current?.version ?? 0);

  let startStageId: mongoose.Types.ObjectId | null = null;
  if (workspaceId) {
    const applied = await stageService.applyFormStages(
      workspaceId,
      formId,
      input.stages.mode === "own" ? { mode: "own", stages: input.stages.stages } : { mode: "workspace" }
    );
    if (input.stages.mode === "own") {
      const start = applied[input.stages.startIndex ?? 0] ?? applied[0];
      startStageId = start._id as mongoose.Types.ObjectId;
      // isDefault marks the starting stage, so "the default stage" means the same thing for a form's stages as for the workspace's.
      await StageModel.updateMany({ formId }, { $set: { isDefault: false } });
      await StageModel.updateOne({ _id: startStageId }, { $set: { isDefault: true } });
    }
  }

  const values = {
    workspaceId: workspaceId ? new mongoose.Types.ObjectId(workspaceId) : null,
    tableColumns: input.tableColumns,
    cardTitle: input.cardTitle,
    opensAs: input.opensAs,
    sort: input.sort,
    respondentFrom: input.respondentFrom,
    rowHeight: input.rowHeight,
    wrap: input.wrap,
    startStageId,
    updatedBy: new mongoose.Types.ObjectId(userId),
    updatedAt: new Date(),
  };
  try {
    if (!current) {
      await ResponseSetup.create({ formId, ...values, version: 1 });
    } else {
      const updated = await ResponseSetup.findOneAndUpdate({ formId, version: input.version }, { $set: values, $inc: { version: 1 } }, { returnDocument: "after" });
      if (!updated) throw staleError();
    }
  } catch (e: any) {
    if (e?.code === 11000) throw staleError();
    throw e;
  }
  return await getResponseSetup(form);
}

/** A duplicate of a form starts with the same setup and its own copy of the form's stages. */
export async function copyResponseSetup(fromFormId: string, toFormId: string, workspaceId: string | null, userId: string): Promise<void> {
  const from = await ResponseSetup.findOne({ formId: fromFormId }).lean<IResponseSetup | null>();
  if (!from) return;
  let startStageId: mongoose.Types.ObjectId | null = null;
  if (workspaceId) {
    const ownStages = await StageModel.find({ formId: fromFormId }).sort({ order: 1 });
    if (ownStages.length > 0) {
      const copies = await StageModel.insertMany(
        ownStages.map((s) => ({ workspaceId: s.workspaceId, formId: toFormId, name: s.name, colour: s.colour, category: s.category, order: s.order, isDefault: s.isDefault }))
      );
      const at = ownStages.findIndex((s) => String(s._id) === String(from.startStageId));
      startStageId = (copies[at >= 0 ? at : 0]?._id as mongoose.Types.ObjectId) ?? null;
    }
  }
  await ResponseSetup.create({
    workspaceId: workspaceId ? new mongoose.Types.ObjectId(workspaceId) : null,
    formId: toFormId,
    tableColumns: from.tableColumns,
    cardTitle: from.cardTitle,
    opensAs: from.opensAs,
    sort: from.sort,
    respondentFrom: from.respondentFrom,
    rowHeight: from.rowHeight,
    wrap: from.wrap,
    startStageId,
    version: 1,
    updatedBy: new mongoose.Types.ObjectId(userId),
  });
}

/** Removes everything the Customize panel stored for forms that are gone for good. */
export async function deleteResponseSetup(formIds: mongoose.Types.ObjectId[]): Promise<void> {
  await Promise.all([ResponseSetup.deleteMany({ formId: { $in: formIds } }), StageModel.deleteMany({ formId: { $in: formIds } })]);
}
