import mongoose, { Schema } from "mongoose";

// One document per (limiter, key, time window). Counted with an atomic upsert, so the limit holds
// across PM2 instances and restarts. MongoDB deletes the document itself once `expiresAt` passes.
const RateLimitBucketSchema = new Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

export const RateLimitBucket = mongoose.model("RateLimitBucket", RateLimitBucketSchema);
