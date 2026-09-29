import mongoose, { Schema, Document } from "mongoose";

// Sprint 12, BE 0.3 (B8.1). One counter document per form; `seq` is only ever moved forward via
// an atomic $inc (see reference.service.ts), never read-then-written in application code, so two
// concurrent submissions to the same form can never land on the same reference.
export interface IFormReferenceCounter extends Document {
  formId: mongoose.Types.ObjectId;
  seq: number;
}

const FormReferenceCounterSchema = new Schema<IFormReferenceCounter>({
  formId: { type: Schema.Types.ObjectId, ref: "Form", required: true, unique: true },
  seq: { type: Number, required: true, default: 0 },
});

const FormReferenceCounter = mongoose.model<IFormReferenceCounter>(
  "FormReferenceCounter",
  FormReferenceCounterSchema
);

export default FormReferenceCounter;
