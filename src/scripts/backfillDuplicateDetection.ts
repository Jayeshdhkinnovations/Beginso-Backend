import mongoose from "mongoose";
import dotenv from "dotenv";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { extractRespondentEmail } from "../services/duplicate.service";

// Sprint 12, BE 0.6 migration (B4.10/B8.3). Back-fills `respondentEmail` and `duplicateOfId` for
// every existing response, per form, in submittedAt order — mirrors backfillResponseReference.ts's
// shape (per-form, oldest-first, idempotent, chunked bulkWrite). Idempotent: only touches responses
// that have never been processed (`respondentEmail: { $exists: false }`), so re-running only fills
// gaps left by forms/responses added since the last run.
//
// Reversible: `db.responses.updateMany({}, { $unset: { respondentEmail: "", duplicateOfId: "" } })`
// removes both fields; every pre-Sprint-12 consumer is untouched by either field's presence, and
// `duplicateOfId`/`respondentEmail` are read defensively (`?? null`) everywhere they're surfaced,
// so unsetting them is a clean rollback, not a partial one.
export interface BackfillDuplicateResult {
  formsProcessed: number;
  responsesProcessed: number;
  duplicatesFlagged: number;
}

export const backfillDuplicateDetection = async (): Promise<BackfillDuplicateResult> => {
  let formsProcessed = 0;
  let responsesProcessed = 0;
  let duplicatesFlagged = 0;

  const forms = await Form.find().select("_id fields").lean();

  for (const form of forms) {
    const unprocessed = await ResponseModel.find({
      formId: form._id,
      respondentEmail: { $exists: false },
    })
      .sort({ submittedAt: 1, _id: 1 })
      .select("_id answers");

    if (unprocessed.length === 0) continue;
    formsProcessed += 1;

    // Seen-so-far map within this form, seeded with any already-processed responses (from a prior
    // partial run) so a re-run after a crash still detects duplicates against them.
    const seen = new Map<string, string>(); // email -> earliest response id
    const alreadyProcessed = await ResponseModel.find({
      formId: form._id,
      respondentEmail: { $ne: null, $exists: true },
    })
      .sort({ submittedAt: 1, _id: 1 })
      .select("_id respondentEmail")
      .lean();
    for (const r of alreadyProcessed) {
      if (r.respondentEmail && !seen.has(r.respondentEmail)) seen.set(r.respondentEmail, r._id.toString());
    }

    const ops: any[] = [];
    for (const r of unprocessed) {
      const email = extractRespondentEmail(form.fields as any, r.answers || {});
      const duplicateOfId = email && seen.has(email) ? seen.get(email)! : null;
      if (email && !seen.has(email)) seen.set(email, r._id.toString());
      if (duplicateOfId) duplicatesFlagged += 1;

      ops.push({
        updateOne: {
          filter: { _id: r._id, respondentEmail: { $exists: false } },
          update: {
            $set: {
              respondentEmail: email,
              duplicateOfId: duplicateOfId ? new mongoose.Types.ObjectId(duplicateOfId) : null,
            },
          },
        },
      });
    }

    const CHUNK = 1000;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const result = await ResponseModel.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
      responsesProcessed += result.modifiedCount || 0;
    }
  }

  return { formsProcessed, responsesProcessed, duplicatesFlagged };
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
    const result = await backfillDuplicateDetection();
    console.log(
      `Backfilled respondentEmail/duplicateOfId on ${result.responsesProcessed} response(s) across ${result.formsProcessed} form(s); ${result.duplicatesFlagged} flagged as duplicates.`
    );
    await mongoose.disconnect();
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
