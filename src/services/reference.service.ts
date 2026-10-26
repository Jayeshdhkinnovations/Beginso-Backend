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

// A response reference is one word: KALCUS0042 = three letters from the workspace's name (KAL), three from the form's title (CUS) and
// the form's running number (0042). Both letter groups are letters only and always three long, so a reference can only be read one
// way: nothing a number does can slide into the letters (a suffix like "CUS2" + "0001" would look the same as "CUS" + "20001").
// The letters are fixed by a form's first response (renaming later changes nothing already handed out). When another workspace /
// form already took them the next free code is used (CUS, CUT, CUU ...), so no two responses share a reference. A personal form
// has no workspace and uses MY (the only two-letter workspace part; no workspace code starts with MY).
export const PERSONAL_CODE = "MY";
const CODE_LEN = 3;
const CODE_SPACE = 26 ** CODE_LEN;

/** The letters of a name, upper-cased and without accents, cut to `len` and padded with X ("Ünï" -> "UNI", "2024 Poll" -> "POL"). */
export const codeFrom = (name: string | undefined | null, len: number = CODE_LEN): string => {
  const letters = String(name ?? "").normalize("NFKD").replace(/[^A-Za-z]/g, "").toUpperCase();
  return (letters + "X".repeat(len)).slice(0, len);
};

/** The code after this one, counting like a number in base 26 (CUS -> CUT, CUZ -> CVA, ZZZ -> AAA). */
export const nextCode = (code: string): string => {
  const chars = code.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] === "Z") chars[i] = "A";
    else {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join("");
    }
  }
  return chars.join("");
};

export const formatReference = (workspaceCode: string, formCode: string, seq: number): string =>
  `${workspaceCode}${formCode}${String(seq).padStart(4, "0")}`;

/** The workspace's three-letter code, given on first use (atomic: the first writer wins, the rest read it back). */
export const ensureWorkspaceCode = async (workspaceId: mongoose.Types.ObjectId | string | null | undefined): Promise<string> => {
  if (!workspaceId) return PERSONAL_CODE;
  const ws = await Workspace.findById(workspaceId).select("name refCode").lean();
  if (!ws) return PERSONAL_CODE;
  if (ws.refCode) return ws.refCode;
  let candidate = codeFrom(ws.name);
  for (let n = 0; n < CODE_SPACE; n++, candidate = nextCode(candidate)) {
    if (candidate.startsWith(PERSONAL_CODE) || (await Workspace.exists({ refCode: candidate }))) continue;
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
  const sameWorkspace = { workspaceId: form.workspaceId ?? null };
  let candidate = codeFrom(form.title);
  for (let n = 0; n < CODE_SPACE; n++, candidate = nextCode(candidate)) {
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
