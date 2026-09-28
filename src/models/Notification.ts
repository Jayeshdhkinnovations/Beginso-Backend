import mongoose, { Schema, Document } from "mongoose";

export interface INotification extends Document {
  userId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  type: "welcome" | "password_reset" | "form_activity";
  title: string;
  message: string;
  read: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["welcome", "password_reset", "form_activity"],
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    read: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// The bell lists a user's newest notifications.
NotificationSchema.index({ userId: 1, createdAt: -1 });

const Notification = mongoose.model<INotification>("Notification", NotificationSchema);

export default Notification;
