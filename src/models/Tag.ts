import mongoose, { Schema, Document } from "mongoose";

// Workspace-owned response tag (Sprint 12, BE 0.2 / B3.1). Name uniqueness is enforced
// case-insensitively per workspace via `nameLower` + a compound unique index, mirroring the
// lower-cased-uniqueness pattern Workspace.slug already uses.
export interface ITag extends Document {
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  nameLower: string;
  colour: string;
  createdAt: Date;
  updatedAt: Date;
}

const TagSchema = new Schema<ITag>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    nameLower: {
      type: String,
      required: true,
    },
    colour: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
    },
  },
  { timestamps: true }
);

TagSchema.pre("validate", function () {
  if (this.name) this.nameLower = this.name.trim().toLowerCase();
});

// Case-insensitive uniqueness per workspace.
TagSchema.index({ workspaceId: 1, nameLower: 1 }, { unique: true });

const TagModel = mongoose.model<ITag>("Tag", TagSchema);
export default TagModel;
