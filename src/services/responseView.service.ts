import mongoose from "mongoose";
import ResponseViewDefault, { ResponseDensity, ResponseLayout } from "../models/ResponseViewDefault";
import UserResponseViewPref from "../models/UserResponseViewPref";

export interface ViewSettings {
  layout: ResponseLayout;
  density: ResponseDensity;
  showEmpty: boolean;
  showNumbers: boolean;
}

export const RESPONSE_VIEW_STALE = "RESPONSE_VIEW_STALE";

// What everybody sees until someone chooses: today's look.
export const SYSTEM_DEFAULT: ViewSettings = { layout: "grid", density: "comfortable", showEmpty: true, showNumbers: true };

const settingsOf = (s: ViewSettings): ViewSettings => ({ layout: s.layout, density: s.density, showEmpty: s.showEmpty, showNumbers: s.showNumbers });

export type ViewSource = "personal" | "personalAll" | "formDefault" | "system";

// THE precedence rule, in one place:
//   personal choice for this form > personal choice for all my forms > form default set by an editor > system default.
// A choice replaces the whole set of four settings; settings are never mixed between levels.
export const pickView = (
  personal: ViewSettings | null | undefined,
  personalAll: ViewSettings | null | undefined,
  formDefault: ViewSettings | null | undefined
): ViewSettings & { source: ViewSource } => {
  if (personal) return { ...settingsOf(personal), source: "personal" };
  if (personalAll) return { ...settingsOf(personalAll), source: "personalAll" };
  if (formDefault) return { ...settingsOf(formDefault), source: "formDefault" };
  return { ...SYSTEM_DEFAULT, source: "system" };
};

const staleError = (currentVersion: number): Error => {
  const err: any = new Error("This form's default view was changed by someone else. Reload it before saving again.");
  err.statusCode = 409;
  err.code = RESPONSE_VIEW_STALE;
  err.currentVersion = currentVersion;
  return err;
};

const toPersonal = (p: any) => (p ? { ...settingsOf(p), scope: p.scope, updatedAt: p.updatedAt } : null);

/** Hiding or pinning a field here is cosmetic: exports, the API and the PDF still include every field. */
const toFormDefault = (d: any, liveFieldIds: Set<string>) => {
  if (!d) return { value: null, dropped: [] as string[] };
  const dropped: string[] = [];
  const keep = (id: string) => (liveFieldIds.has(id) ? true : (dropped.push(id), false));
  const pinned = (d.pinned ?? []).filter(keep);
  const fields = (d.fields ?? []).filter((f: any) => keep(f.fieldId)).map((f: any) => ({ fieldId: f.fieldId, hidden: f.hidden, span: f.span, order: f.order }));
  return {
    value: { ...settingsOf(d), pinned, fields, version: d.version, updatedBy: String(d.updatedBy), updatedAt: d.updatedAt },
    dropped: [...new Set(dropped)],
  };
};

export const liveFieldIdsOf = (form: { fields?: { fieldId?: string; deleted?: boolean }[] }): Set<string> =>
  new Set((form.fields ?? []).filter((f) => !f.deleted && f.fieldId).map((f) => f.fieldId as string));

export const getViewForForm = async (userId: string, form: { _id: any; fields?: any[] }) => {
  const formId = String(form._id);
  const [personal, personalAll, def] = await Promise.all([
    UserResponseViewPref.findOne({ userId, scope: formId }).lean(),
    UserResponseViewPref.findOne({ userId, scope: "all" }).lean(),
    ResponseViewDefault.findOne({ formId }).lean(),
  ]);
  const { value: formDefault, dropped } = toFormDefault(def, liveFieldIdsOf(form));
  return {
    resolved: pickView(personal as any, personalAll as any, def as any),
    formDefault,
    personal: toPersonal(personal),
    personalAll: toPersonal(personalAll),
    dropped,
  };
};

export const savePersonalView = async (userId: string, scope: string, s: ViewSettings) => {
  const doc = await UserResponseViewPref.findOneAndUpdate(
    { userId, scope },
    { $set: { ...settingsOf(s), updatedAt: new Date() } },
    { upsert: true, returnDocument: "after", runValidators: true }
  ).lean();
  return toPersonal(doc);
};

export const clearPersonalView = async (userId: string, scope: string): Promise<void> => {
  await UserResponseViewPref.deleteOne({ userId, scope });
};

// Compare-and-swap on `version`, the same idea as the form builder's contentVersion: a save based on an older
// version is refused with 409 instead of overwriting a teammate's change. expectedVersion 0 means "no default yet".
export const saveFormDefault = async (
  form: { _id: any; workspaceId?: any; fields?: any[] },
  userId: string,
  s: ViewSettings,
  expectedVersion: number
) => {
  const formId = new mongoose.Types.ObjectId(String(form._id));
  const data = { ...settingsOf(s), workspaceId: form.workspaceId ?? null, updatedBy: userId, updatedAt: new Date() };
  const currentVersion = async () => ((await ResponseViewDefault.findOne({ formId }).select("version").lean())?.version ?? 0);

  let saved: any;
  if (expectedVersion === 0) {
    try {
      saved = (await ResponseViewDefault.create({ ...data, formId, version: 1 })).toObject();
    } catch (err: any) {
      if (err?.code === 11000) throw staleError(await currentVersion());
      throw err;
    }
  } else {
    saved = await ResponseViewDefault.findOneAndUpdate(
      { formId, version: expectedVersion },
      { $set: data, $inc: { version: 1 } },
      { returnDocument: "after", runValidators: true }
    ).lean();
    if (!saved) throw staleError(await currentVersion());
  }
  return toFormDefault(saved, liveFieldIdsOf(form)).value;
};
