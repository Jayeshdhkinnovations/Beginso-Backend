import mongoose from "mongoose";
import dotenv from "dotenv";
import ResponseModel from "../models/Response";
import { buildSearchText } from "../utils/responseSearch";

// Adds `searchText` to responses stored before it existed. Safe to re-run: it only touches
// responses that do not have it yet, so it needs no --yes flag and changes no other field.
export const backfillResponseSearchText = async (): Promise<number> => {
  let updated = 0;
  const cursor = ResponseModel.find({ searchText: { $exists: false } }).select("answers").lean().cursor();
  let batch: any[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await ResponseModel.collection.bulkWrite(batch, { ordered: false });
    updated += batch.length;
    batch = [];
  };
  for await (const r of cursor) {
    batch.push({ updateOne: { filter: { _id: r._id }, update: { $set: { searchText: buildSearchText(r.answers) } } } });
    if (batch.length >= 500) await flush();
  }
  await flush();
  return updated;
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
    console.log(`Backfilled searchText on ${await backfillResponseSearchText()} responses.`);
    await mongoose.disconnect();
  };
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
