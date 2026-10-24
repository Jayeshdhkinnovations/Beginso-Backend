import mongoose from "mongoose";
import dotenv from "dotenv";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { ensureFormCode, ensureWorkspaceCode, formatReference } from "../services/reference.service";

// Moves every response's reference from the old per-form "#12" to the workspace + form + number form ("KA-CUS-0012"). The number
// stays the same, so "#12" and "KA-CUS-0012" are the same response; the old text is kept in `legacyReference` and stays searchable.
// Idempotent: only a reference that still reads "#<number>" is touched, so a re-run (or a form that already has some new-style
// references) only converts what is left. The per-form counter is not touched: new responses carry on from where it is.
export interface BackfillReferenceFormatResult {
  formsProcessed: number;
  responsesConverted: number;
}

const OLD_STYLE = /^#(\d+)$/;

export const backfillReferenceFormat = async (): Promise<BackfillReferenceFormatResult> => {
  let formsProcessed = 0;
  let responsesConverted = 0;

  const forms = await Form.find().setOptions({ includeDeleted: true }).select("_id workspaceId").lean();
  for (const form of forms) {
    const old = await ResponseModel.find({ formId: form._id, reference: OLD_STYLE }).select("_id reference").lean();
    if (old.length === 0) continue;
    formsProcessed += 1;

    const workspaceCode = await ensureWorkspaceCode(form.workspaceId);
    const formCode = await ensureFormCode(form._id);
    const ops = old.map((r) => {
      const seq = Number(OLD_STYLE.exec(String(r.reference))![1]);
      return {
        updateOne: {
          filter: { _id: r._id, reference: r.reference },
          update: { $set: { reference: formatReference(workspaceCode, formCode, seq), legacyReference: r.reference } },
        },
      };
    });

    const CHUNK = 1000;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const result = await ResponseModel.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
      responsesConverted += result.modifiedCount || 0;
    }
  }
  return { formsProcessed, responsesConverted };
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
    const result = await backfillReferenceFormat();
    console.log(`Converted ${result.responsesConverted} reference(s) across ${result.formsProcessed} form(s).`);
    await mongoose.disconnect();
  };
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
