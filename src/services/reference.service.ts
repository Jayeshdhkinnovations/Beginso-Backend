import mongoose from "mongoose";
import FormReferenceCounter from "../models/FormReferenceCounter";
import Form from "../models/Form";
import Workspace from "../models/Workspace";

// The unique index on `formId` is what makes the very-first allocation for a brand-new form
// race-safe: without it, two concurrent upserts can each see "no document yet" and both insert
// (MongoDB's own documented upsert caveat), which is a real duplicate, not a theoretical one — an
// earlier version of this file failed exactly that scenario under test. Mongoose builds indexes in
// the background by default, so this is awaited (and cached) before the first allocation rather
// than assumed to already exist.
let indexesReady: Promise<unknown> | null = null;
const ensureIndexes = (): Promise<unknown> => {
  if (!indexesReady) indexesReady = FormReferenceCounter.init();
  return indexesReady;
};

// A response reference reads WS-FRM-0042: two letters from the workspace's name, three from the form's title, and the form's
// running number. The letters are fixed by the first response (renaming later changes nothing already handed out) and are made
// unique by a number on the end when another workspace / form already took them (KA, KA2 ... and CUS, CUS2 ...), so no two
// responses anywhere share a reference. A personal form has no workspace and uses MY.
export const PERSONAL_CODE = "MY";
const MAX_SUFFIX = 500;

/** The letters and digits of a name, upper-cased and without accents, cut to `len` and padded with X ("Ünï" -> "UNI"). */
export const codeFrom = (name: string | undefined | null, len: number): string => {
  const letters = String(name ?? "").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return (letters + "X".repeat(len)).slice(0, len);
};

export const formatReference = (workspaceCode: string, formCode: string, seq: number): string =>
  `${workspaceCode}-${formCode}-${String(seq).padStart(4, "0")}`;

/** The workspace's two-letter code, given on first use (atomic: the first writer wins, the rest read it back). */
export const ensureWorkspaceCode = async (workspaceId: mongoose.Types.ObjectId | string | null | undefined): Promise<string> => {
  if (!workspaceId) return PERSONAL_CODE;
  const ws = await Workspace.findById(workspaceId).select("name refCode").lean();
  if (!ws) return PERSONAL_CODE;
  if (ws.refCode) return ws.refCode;
  const base = codeFrom(ws.name, 2);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const candidate = n === 1 ? base : `${base}${n}`;
    if (candidate === PERSONAL_CODE || (await Workspace.exists({ refCode: candidate }))) continue;
    try {
      const done = await Workspace.updateOne({ _id: ws._id, refCode: { $exists: false } }, { $set: { refCode: candidate } });
      if (done.modifiedCount === 0) return (await Workspace.findById(ws._id).select("refCode").lean())?.refCode ?? candidate;
      return candidate;
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error("No free workspace reference code");
};

/** The form's three-letter code, given on first use; unique within its workspace (trashed forms keep theirs). */
export const ensureFormCode = async (formId: mongoose.Types.ObjectId | string): Promise<string> => {
  const form = await Form.findById(formId).setOptions({ includeDeleted: true }).select("title workspaceId refCode").lean();
  if (!form) return "XXX";
  if (form.refCode) return form.refCode;
  const base = codeFrom(form.title, 3);
  const sameWorkspace = { workspaceId: form.workspaceId ?? null };
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const candidate = n === 1 ? base : `${base}${n}`;
    if (await Form.exists({ ...sameWorkspace, refCode: candidate }).setOptions({ includeDeleted: true })) continue;
    try {
      const done = await Form.updateOne({ _id: form._id, refCode: { $exists: false } }, { $set: { refCode: candidate } });
      if (done.modifiedCount === 0) return (await Form.findById(form._id).setOptions({ includeDeleted: true }).select("refCode").lean())?.refCode ?? candidate;
      return candidate;
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error("No free form reference code");
};

// Sprint 12, BE 0.3 (B8.1). Per-form running number inside the reference. Race-safe: a single atomic findOneAndUpdate($inc)
// per form, upserted on first use — never read-then-increment in application code, which is what would let two concurrent
// submissions to the same form land on the same number. The duplicate-key retry is defence in depth for the (now-closed)
// window above: if it ever fires, the document already exists and the retry is a plain atomic $inc against it.
// A number is never handed out twice, so deleting a response leaves a gap that nothing fills.
export const allocateReference = async (formId: string | mongoose.Types.ObjectId): Promise<string> => {
  await ensureIndexes();
  const form = await Form.findById(formId).setOptions({ includeDeleted: true }).select("workspaceId").lean();
  const workspaceCode = await ensureWorkspaceCode(form?.workspaceId);
  const formCode = await ensureFormCode(formId);
  const seq = await nextSeq(formId);
  return formatReference(workspaceCode, formCode, seq);
};

const nextSeq = async (formId: string | mongoose.Types.ObjectId): Promise<number> => {
  try {
    const counter = await FormReferenceCounter.findOneAndUpdate(
      { formId },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    return counter.seq;
  } catch (err: any) {
    if (err?.code === 11000) return nextSeq(formId);
    throw err;
  }
};

// Migration-only: advances the counter to at least `seq` without going backwards, so a re-run
// (or a form that already had live allocations mixed with back-filled ones) never regresses it.
export const bumpReferenceCounter = async (formId: string | mongoose.Types.ObjectId, seq: number): Promise<void> => {
  await FormReferenceCounter.findOneAndUpdate(
    { formId },
    { $max: { seq } },
    { upsert: true }
  );
};
