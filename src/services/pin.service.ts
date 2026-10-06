import mongoose from "mongoose";
import Form from "../models/Form";
import FormPin from "../models/FormPin";
import FormAccessGrant from "../models/FormAccessGrant";
import Membership from "../models/Membership";
import Workspace from "../models/Workspace";

export const PIN_LIMIT = 50;

// Can this user read this form right now? Same rule as the form routes: workspace member, per-form
// grant, or creator of a personal form.
export const userCanReadForm = async (
  userId: string,
  form: { _id: any; workspaceId?: any; createdBy?: any }
): Promise<boolean> => {
  if (!form.workspaceId) {
    if (form.createdBy && String(form.createdBy) === userId) return true;
  } else {
    if (await Membership.exists({ userId, workspaceId: form.workspaceId })) return true;
    if (await Workspace.exists({ _id: form.workspaceId, owner: userId })) return true;
  }
  return !!(await FormAccessGrant.exists({ userId, formId: form._id }));
};

// Pins still pointing at a live (not trashed) form the user can read. Stale rows are deleted so they
// never count toward the cap. Used only when the cap is reached.
const pruneStalePins = async (userId: string): Promise<number> => {
  const pins = await FormPin.find({ userId }).lean();
  const forms = await Form.find({ _id: { $in: pins.map((p) => p.formId) } }).select("_id workspaceId createdBy").lean();
  const byId = new Map(forms.map((f: any) => [String(f._id), f]));
  const stale: any[] = [];
  for (const p of pins) {
    const f = byId.get(String(p.formId));
    if (!f || !(await userCanReadForm(userId, f))) stale.push(p._id);
  }
  if (stale.length) await FormPin.deleteMany({ _id: { $in: stale } });
  return pins.length - stale.length;
};

// Returns the pin, or "limit" when the user already has PIN_LIMIT live pins. Idempotent.
export const pinForm = async (userId: string, form: { _id: any; workspaceId?: any }) => {
  const existing = await FormPin.findOne({ userId, formId: form._id }).lean();
  if (existing) return existing;
  if ((await FormPin.countDocuments({ userId })) >= PIN_LIMIT && (await pruneStalePins(userId)) >= PIN_LIMIT) {
    return "limit" as const;
  }
  try {
    return await FormPin.findOneAndUpdate(
      { userId, formId: form._id },
      { $setOnInsert: { workspaceId: form.workspaceId ?? null, pinnedAt: new Date() } },
      { upsert: true, returnDocument: "after" }
    ).lean();
  } catch (err: any) {
    if (err?.code !== 11000) throw err; // concurrent double-pin: the other request won
    return await FormPin.findOne({ userId, formId: form._id }).lean();
  }
};

export const unpinForm = async (userId: string, formId: string): Promise<void> => {
  await FormPin.deleteOne({ userId, formId });
};

// pinnedAt per formId for one page of forms: a single query, no N+1.
export const pinsFor = async (userId: string, formIds: any[]): Promise<Map<string, Date>> => {
  if (!formIds.length) return new Map();
  const pins = await FormPin.find({ userId, formId: { $in: formIds } }).select("formId pinnedAt").lean();
  return new Map(pins.map((p) => [String(p.formId), p.pinnedAt]));
};

// A moved form: users with no access in the new context lose their pin; the rest follow the form.
export const reconcilePinsAfterMove = async (form: { _id: any; workspaceId?: any; createdBy?: any }): Promise<void> => {
  if (form.workspaceId) {
    const ws: any = await Workspace.findById(form.workspaceId).select("owner").lean();
    const members: any[] = await Membership.distinct("userId", { workspaceId: form.workspaceId });
    if (ws?.owner) members.push(ws.owner);
    await FormPin.deleteMany({ formId: form._id, userId: { $nin: members } });
  } else {
    await FormPin.deleteMany({ formId: form._id, userId: { $ne: form.createdBy } });
  }
  await FormPin.updateMany({ formId: form._id }, { $set: { workspaceId: form.workspaceId ?? null } });
};

export const isValidId = (id: unknown): id is string => typeof id === "string" && mongoose.Types.ObjectId.isValid(id);
