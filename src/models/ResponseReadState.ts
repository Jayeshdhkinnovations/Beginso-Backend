import mongoose, { Schema, Document } from "mongoose";

// Per-user read state for a response (Sprint 12, BE 0.2 / B8.2). Absence of a row means unread —
// this collection only ever records that a user HAS read a response, never the negative, so
// "mark unread" is a delete, not a boolean flip.
export interface IResponseReadState extends Document {
  userId: mongoose.Types.ObjectId;
  responseId: mongoose.Types.ObjectId;
  readAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ResponseReadStateSchema = new Schema<IResponseReadState>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    responseId: {
      type: Schema.Types.ObjectId,
      ref: "Response",
      required: true,
    },
    readAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// One row per (user, response); also the hot lookup for the list-endpoint batch join.
ResponseReadStateSchema.index({ userId: 1, responseId: 1 }, { unique: true });

const ResponseReadStateModel = mongoose.model<IResponseReadState>(
  "ResponseReadState",
  ResponseReadStateSchema
);
export default ResponseReadStateModel;
