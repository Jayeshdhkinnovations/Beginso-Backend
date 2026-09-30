import mongoose, { Schema, Document } from "mongoose";

// One reviewer's score for one criterion on one response (Sprint 12, BE 0.5 / B6.1, OQ-7 resolved
// 3 Oct 2026). Deliberately row-per-(response, reviewer, criterion) — NOT one document per reviewer
// holding a map of criterion -> value — so a reviewer re-scoring one criterion upserts only that
// row and never touches their own or any other reviewer's rows for other criteria.
export interface IScoreEntry extends Document {
  responseId: mongoose.Types.ObjectId;
  reviewerMembershipId: mongoose.Types.ObjectId;
  criterionId: mongoose.Types.ObjectId;
  value: number;
  createdAt: Date;
  updatedAt: Date;
}

const ScoreEntrySchema = new Schema<IScoreEntry>(
  {
    responseId: {
      type: Schema.Types.ObjectId,
      ref: "Response",
      required: true,
      index: true,
    },
    reviewerMembershipId: {
      type: Schema.Types.ObjectId,
      ref: "Membership",
      required: true,
    },
    criterionId: {
      type: Schema.Types.ObjectId,
      ref: "ScoreCriterion",
      required: true,
    },
    value: {
      type: Number,
      required: true,
      min: 1,
      max: 10,
    },
  },
  { timestamps: true }
);

// The upsert key: one row per reviewer per criterion per response, never overwritten across
// reviewers or criteria.
ScoreEntrySchema.index(
  { responseId: 1, reviewerMembershipId: 1, criterionId: 1 },
  { unique: true }
);

const ScoreEntryModel = mongoose.model<IScoreEntry>("ScoreEntry", ScoreEntrySchema);
export default ScoreEntryModel;
