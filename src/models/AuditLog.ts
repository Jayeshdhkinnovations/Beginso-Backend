import mongoose, { Schema, Document } from "mongoose";

export interface IAuditLog extends Document {
  timestamp: Date;
  actorId: mongoose.Types.ObjectId;
  actorEmail: string;
  actorName: string;
  action: "admin.create" | "admin.edit" | "admin.suspend" | "admin.reactivate" | "admin.delete" | "admin.limits" | "workspace.delete" | "template.create" | "template.edit" | "template.delete" | "session.revoke" | "report.retry";
  targetId: string;
  targetType: "admin" | "workspace" | "form" | "template" | "session" | "report";
  before?: Record<string, any>;
  after?: Record<string, any>;
}

const AuditLogSchema = new Schema<IAuditLog>({
  timestamp: { type: Date, default: Date.now, required: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  actorEmail: { type: String, required: true },
  actorName: { type: String, required: true },
  action: { type: String, required: true, index: true },
  targetId: { type: String, required: true, index: true },
  targetType: { type: String, required: true },
  before: { type: Schema.Types.Mixed },
  after: { type: Schema.Types.Mixed }
});

// Enforce append-only / immutability on Mongoose level
AuditLogSchema.pre("save", function () {
  if (!this.isNew) {
    throw new Error("Cannot update an immutable audit log entry");
  }
});

const preventMutation = function (next: any) {
  next(new Error("Mutations are not allowed on the immutable audit log collection"));
};

AuditLogSchema.pre("updateOne", preventMutation);
AuditLogSchema.pre("updateMany", preventMutation);
AuditLogSchema.pre("deleteOne", preventMutation);
AuditLogSchema.pre("deleteMany", preventMutation);
AuditLogSchema.pre("findOneAndDelete", preventMutation);
AuditLogSchema.pre("findOneAndUpdate", preventMutation);
AuditLogSchema.pre("findOneAndReplace", preventMutation);

export const AuditLog = mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
