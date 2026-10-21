import mongoose, { Schema, Document } from "mongoose";
import { RESPONSE_LAYOUTS, RESPONSE_DENSITIES, ResponseLayout, ResponseDensity } from "./ResponseViewDefault";

// One person's own choice of response layout: scope "all" (every form) or one formId. Private to that user.
export interface IUserResponseViewPref extends Document {
  userId: mongoose.Types.ObjectId;
  scope: string; // "all" | <formId>
  layout: ResponseLayout;
  density: ResponseDensity;
  showEmpty: boolean;
  showNumbers: boolean;
  updatedAt: Date;
}

const UserResponseViewPrefSchema = new Schema<IUserResponseViewPref>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  scope: { type: String, required: true },
  layout: { type: String, enum: RESPONSE_LAYOUTS, required: true },
  density: { type: String, enum: RESPONSE_DENSITIES, required: true },
  showEmpty: { type: Boolean, required: true },
  showNumbers: { type: Boolean, required: true },
  updatedAt: { type: Date, default: Date.now },
});

UserResponseViewPrefSchema.index({ userId: 1, scope: 1 }, { unique: true });

export default mongoose.model<IUserResponseViewPref>("UserResponseViewPref", UserResponseViewPrefSchema);
