import mongoose, { Schema, Document } from "mongoose";

// One row per user per UTC day they used the product. Session.lastActiveAt keeps only the latest time, so past days
// cannot be rebuilt from it. It holds a user id and a day, nothing else, and rows expire after 400 days.
export interface IUserActivity extends Document {
  userId: mongoose.Types.ObjectId;
  day: Date;
}

const UserActivitySchema = new Schema<IUserActivity>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    day: { type: Date, required: true },
  },
  { versionKey: false }
);

UserActivitySchema.index({ userId: 1, day: 1 }, { unique: true });
UserActivitySchema.index({ day: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

const UserActivity = mongoose.model<IUserActivity>("UserActivity", UserActivitySchema);
export default UserActivity;

/** Marks the user as active today. Never fails the request it is part of. */
export const recordActivity = async (userId: mongoose.Types.ObjectId | string, at: Date = new Date()): Promise<void> => {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  try {
    await UserActivity.updateOne({ userId, day }, { $setOnInsert: { userId, day } }, { upsert: true });
  } catch {
    // two requests inserting the same day at once, or a database hiccup: nothing the caller should hear about
  }
};
