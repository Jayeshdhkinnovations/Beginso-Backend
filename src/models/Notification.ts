import mongoose, { Schema, Document } from "mongoose";

export interface INotification extends Document {
  userId: mongoose.Types.ObjectId;
  // Sprint 14 (OQ-7): optional. A notification with no usable workspaceId belongs to the user's personal context.
  workspaceId?: mongoose.Types.ObjectId | null;
  type: "welcome" | "password_reset" | "form_activity" | "assignment" | "mention" | "response_edited" | "form_shared";
  /** Set on form_shared: the form that was shared, so the UI can link to it. */
  formId?: mongoose.Types.ObjectId | null;
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
      required: false,
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: ["welcome", "password_reset", "form_activity", "assignment", "mention", "response_edited", "form_shared"],
      required: true,
    },
    formId: { type: Schema.Types.ObjectId, ref: "Form", required: false, default: null },
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
// Sprint 14: unread-count and the context-scoped, unread-filtered list.
NotificationSchema.index({ userId: 1, workspaceId: 1, read: 1, createdAt: -1 });

const Notification = mongoose.model<INotification>("Notification", NotificationSchema);

export default Notification;
