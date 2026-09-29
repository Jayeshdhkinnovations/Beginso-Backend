import mongoose from "mongoose";
import dotenv from "dotenv";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { bumpReferenceCounter } from "../services/reference.service";

// Sprint 12, BE 0.3 migration (B8.1). Back-fills `reference` for every existing response, per
// form, in submittedAt order, starting from 1. Idempotent: only touches responses with no
// reference yet, so re-running only fills gaps (e.g. after new forms/responses were added since
// the last run). The per-form counter is bumped to the last-assigned seq afterwards so future
// live allocations (reference.service.ts) continue from where the backfill left off rather than
// colliding with it.
export interface BackfillReferenceResult {
  formsProcessed: number;
  responsesBackfilled: number;
}

export const backfillResponseReference = async (): Promise<BackfillReferenceResult> => {
  let formsProcessed = 0;
  let responsesBackfilled = 0;

  const forms = await Form.find().select("_id").lean();

  for (const form of forms) {
    const unreferenced = await ResponseModel.find({
      formId: form._id,
      $or: [{ reference: { $exists: false } }, { reference: null }],
    })
      .sort({ submittedAt: 1, _id: 1 })
      .select("_id");

    if (unreferenced.length === 0) continue;
    formsProcessed += 1;

    // Existing (already-referenced) responses may already occupy the low end of the sequence
    // (e.g. a form that had live allocations before the backfill ran on it) — start after the
    // current max so nothing collides.
    const highest = await ResponseModel.find({ formId: form._id, reference: { $exists: true, $ne: null } })
      .select("reference")
      .lean();
    let seq = highest.reduce((max, r) => {
      const n = Number(String(r.reference || "").replace(/^#/, ""));
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);

    const ops = unreferenced.map((r) => {
      seq += 1;
      return {
        updateOne: {
          filter: { _id: r._id, $or: [{ reference: { $exists: false } }, { reference: null }] },
          update: { $set: { reference: `#${seq}` } },
        },
      };
    });

    const CHUNK = 1000;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const result = await ResponseModel.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
      responsesBackfilled += result.modifiedCount || 0;
    }

    await bumpReferenceCounter(form._id, seq);
  }

  return { formsProcessed, responsesBackfilled };
};

if (require.main === module) {
  dotenv.config();
  const run = async () => {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
      console.error("Set MONGODB_URI (or MONGO_URI). Refusing to guess which database to change.");
      process.exit(1);
    }
    await mongoose.connect(mongoUri);
    const result = await backfillResponseReference();
    console.log(
      `Backfilled reference for ${result.responsesBackfilled} response(s) across ${result.formsProcessed} form(s).`
    );
    await mongoose.disconnect();
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
