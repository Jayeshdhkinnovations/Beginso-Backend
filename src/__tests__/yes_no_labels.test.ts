import { fieldSchema } from "../validations/form.validator";
import { FormFieldSchema } from "../models/Form";
import mongoose from "mongoose";

const yesNo = (extra: Record<string, unknown> = {}) => ({ fieldId: "f1", label: "Attending?", type: "yes_no", required: true, ...extra });

describe("yes_no yesLabel / noLabel", () => {
  it("accepts custom words and trims them", () => {
    const r = fieldSchema.safeParse(yesNo({ yesLabel: "  I will be there ", noLabel: "Sorry, I can't" }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ yesLabel: "I will be there", noLabel: "Sorry, I can't" });
  });

  it("is fine with no labels (the buttons then say Yes and No)", () => {
    expect(fieldSchema.safeParse(yesNo()).success).toBe(true);
  });

  it("rejects an empty word and one over 30 characters", () => {
    expect(fieldSchema.safeParse(yesNo({ yesLabel: "   " })).success).toBe(false);
    expect(fieldSchema.safeParse(yesNo({ noLabel: "x".repeat(31) })).success).toBe(false);
  });

  it("is stored on the field, and the answer stays Yes / No (labels are display only)", () => {
    const Field = mongoose.model("YesNoLabelProbe", FormFieldSchema);
    const doc = new Field({ label: "Attending?", type: "yes_no", yesLabel: "Going", noLabel: "Not going" });
    expect(doc.yesLabel).toBe("Going");
    expect(doc.noLabel).toBe("Not going");
    expect(doc.validateSync()).toBeUndefined();
  });
});
