import mongoose, { Schema, Document } from "mongoose";

// Sprint 12, BE 0.3 (B5.1/B5.2/B5.3). Never reachable from any respondent-facing, public or
// export path — see note.service.ts's header comment for the security boundary this enforces.
export interface INote extends Document {
  responseId: mongoose.Types.ObjectId;
  authorId: mongoose.Types.ObjectId;
  // Snapshot of the author's display name at write time, same convention as Event.actorName —
  // survives the author later being renamed or removed.
  authorName: string;
  // ponytail: stored for the shape the spec calls for, but nothing yet flips it true on removal
  // (that's B3.3, not in this sprint's scope) — note.service.ts's toDTO recomputes it live from
  // current form access instead, so the returned value is always correct regardless of this
  // column. Upgrade path: a membership-removal hook that sets this on every existing note.
  authorRemoved: boolean;
  body: string;
  mentionIds: mongoose.Types.ObjectId[];
  editedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const NoteSchema = new Schema<INote>(
  {
    responseId: { type: Schema.Types.ObjectId, ref: "Response", required: true, index: true },
    authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    authorName: { type: String, required: true },
    authorRemoved: { type: Boolean, default: false },
    body: { type: String, required: true, minlength: 1, maxlength: 5000, trim: true },
    mentionIds: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: [] },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Note list (newest-first display) and live noteCount aggregation both key off responseId.
NoteSchema.index({ responseId: 1, createdAt: 1 });

const Note = mongoose.model<INote>("Note", NoteSchema);
export default Note;
