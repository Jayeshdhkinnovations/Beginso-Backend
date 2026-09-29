import mongoose from "mongoose";
import FormReferenceCounter from "../models/FormReferenceCounter";

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

// Sprint 12, BE 0.3 (B8.1). Per-form sequential, human-readable response reference ("#142").
// Race-safe: a single atomic findOneAndUpdate($inc) per form, upserted on first use — never
// read-then-increment in application code, which is what would let two concurrent submissions to
// the same form land on the same number. The duplicate-key retry is defence in depth for the
// (now-closed) window above: if it ever fires, the document already exists and the retry is a
// plain atomic $inc against it.
export const allocateReference = async (formId: string | mongoose.Types.ObjectId): Promise<string> => {
  await ensureIndexes();
  try {
    const counter = await FormReferenceCounter.findOneAndUpdate(
      { formId },
      { $inc: { seq: 1 } },
      { upsert: true, new: true }
    );
    return `#${counter.seq}`;
  } catch (err: any) {
    if (err?.code === 11000) return allocateReference(formId);
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
