import mongoose, { Schema, Document } from "mongoose";

export interface IEvent extends Document {
  workspaceId: mongoose.Types.ObjectId;
  actorId?: mongoose.Types.ObjectId | null;
  actorEmail: string;
  actorName: string;
  action: string;
  targetId: string;
  targetType: string;
  targetLabel: string;
  metadata?: Record<string, any>;
  ip?: string; // hashed, never the raw address
  createdAt: Date;
}

const EventSchema = new Schema<IEvent>({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User", index: true }, // null: unauthenticated actor (e.g. invitee declining)
  actorEmail: { type: String, required: true },
  actorName: { type: String, required: true },
  action: { type: String, required: true, index: true },
  targetId: { type: String, required: true, index: true },
  targetType: { type: String, required: true },
  targetLabel: { type: String, required: true },
  metadata: { type: Schema.Types.Mixed },
  ip: { type: String },
  createdAt: { type: Date, default: Date.now, required: true, index: true }
});

// Feeds: workspace activity/audit (newest first) and per-form activity.
EventSchema.index({ workspaceId: 1, createdAt: -1 });
EventSchema.index({ targetId: 1, createdAt: -1 });

// Enforce append-only / immutability on Mongoose level
EventSchema.pre("save", function () {
  if (!this.isNew) {
    throw new Error("Cannot update an immutable event log entry");
  }
});

const preventMutation = function (next: any) {
  next(new Error("Mutations are not allowed on the immutable event collection"));
};

EventSchema.pre("updateOne", preventMutation);
EventSchema.pre("updateMany", preventMutation);
EventSchema.pre("deleteOne", preventMutation);
EventSchema.pre("deleteMany", preventMutation);
EventSchema.pre("findOneAndDelete", preventMutation);
EventSchema.pre("findOneAndUpdate", preventMutation);
EventSchema.pre("findOneAndReplace", preventMutation);

export const Event = mongoose.model<IEvent>("Event", EventSchema);
