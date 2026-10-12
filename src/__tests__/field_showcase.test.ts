import { createFormSchema } from "../validations/form.validator";
import { fieldShowcaseTemplate } from "../utils/fieldShowcaseTemplate";

// The showcase template must itself pass the form validator, or "Use template" would produce a form that cannot be saved.
describe("Field Showcase template", () => {
  it("covers every field type and every field passes the form validator", () => {
    const types = new Set(fieldShowcaseTemplate.fields.map((x) => x.type));
    expect(types.size).toBe(19);
    const result = createFormSchema.safeParse({ title: "Showcase", fields: fieldShowcaseTemplate.fields, pages: fieldShowcaseTemplate.pages });
    expect(result.success).toBe(true);
  });
});
