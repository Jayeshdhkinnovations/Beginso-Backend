import {
  fieldSchema,
  createFormSchema,
  patchFormSchema,
  validateFieldsIntegrity,
} from "../validations/form.validator";
import { IFormField } from "../models/Form";

describe("fieldSchema - number constraints", () => {
  it("rejects min === max", () => {
    const result = fieldSchema.safeParse({
      label: "Age",
      type: "number",
      required: false,
      min: 10,
      max: 10,
    });
    expect(result.success).toBe(false);
  });

  it("accepts min < max", () => {
    const result = fieldSchema.safeParse({
      label: "Age",
      type: "number",
      required: false,
      min: 10,
      max: 20,
    });
    expect(result.success).toBe(true);
  });
});

describe("fieldSchema - text maxLength", () => {
  it("rejects maxLength of 0", () => {
    const result = fieldSchema.safeParse({
      label: "Name",
      type: "short_text",
      required: false,
      maxLength: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative maxLength", () => {
    const result = fieldSchema.safeParse({
      label: "Name",
      type: "short_text",
      required: false,
      maxLength: -5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer maxLength", () => {
    const result = fieldSchema.safeParse({
      label: "Name",
      type: "short_text",
      required: false,
      maxLength: 4.5,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a positive integer maxLength", () => {
    const result = fieldSchema.safeParse({
      label: "Name",
      type: "short_text",
      required: false,
      maxLength: 50,
    });
    expect(result.success).toBe(true);
  });
});

describe("fieldSchema - date shapes", () => {
  it("rejects a non-ISO date string", () => {
    const result = fieldSchema.safeParse({
      label: "DOB",
      type: "date",
      required: false,
      minDate: "01-01-2026",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid YYYY-MM-DD date", () => {
    const result = fieldSchema.safeParse({
      label: "DOB",
      type: "date",
      required: false,
      minDate: "2026-01-01",
      maxDate: "2026-12-31",
    });
    expect(result.success).toBe(true);
  });
});

describe("fieldSchema - choice field options", () => {
  it("rejects a dropdown with zero options", () => {
    const result = fieldSchema.safeParse({
      label: "Pick one",
      type: "dropdown",
      required: false,
      options: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a multiple_choice field with zero options", () => {
    const result = fieldSchema.safeParse({
      label: "Pick many",
      type: "multiple_choice",
      required: false,
      options: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a checkbox field with zero/omitted options (boolean toggle)", () => {
    const withEmptyArray = fieldSchema.safeParse({
      label: "Agree",
      type: "checkbox",
      required: false,
      options: [],
    });
    const withNoOptions = fieldSchema.safeParse({
      label: "Agree",
      type: "checkbox",
      required: false,
    });
    expect(withEmptyArray.success).toBe(true);
    expect(withNoOptions.success).toBe(true);
  });
});

describe("validateFieldsIntegrity", () => {
  const field = (overrides: Partial<IFormField>): IFormField => ({
    fieldId: overrides.fieldId,
    label: overrides.label ?? "Field",
    type: overrides.type ?? "short_text",
    required: overrides.required ?? false,
    deleted: overrides.deleted ?? false,
    logicRules: overrides.logicRules,
  });

  it("passes for a form with no logic rules", () => {
    const fields = [field({ fieldId: "a" }), field({ fieldId: "b" })];
    expect(() => validateFieldsIntegrity(fields)).not.toThrow();
  });

  it("passes when a rule targets a soft-deleted field (orphan tolerance)", () => {
    const fields = [
      field({
        fieldId: "a",
        logicRules: [{ targetFieldId: "b", operator: "equals", value: "x", action: "hide" }],
      }),
      field({ fieldId: "b", deleted: true }),
    ];
    expect(() => validateFieldsIntegrity(fields)).not.toThrow();
  });

  it("throws LOGIC_RULE_INVALID_TARGET for a nonexistent targetFieldId", () => {
    const fields = [
      field({
        fieldId: "a",
        logicRules: [{ targetFieldId: "does-not-exist", operator: "equals", value: "x", action: "hide" }],
      }),
    ];
    try {
      validateFieldsIntegrity(fields);
      fail("expected validateFieldsIntegrity to throw");
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe("LOGIC_RULE_INVALID_TARGET");
    }
  });

  it("throws LOGIC_RULE_SELF_REFERENCE when a rule targets its own field", () => {
    const fields = [
      field({
        fieldId: "a",
        logicRules: [{ targetFieldId: "a", operator: "equals", value: "x", action: "hide" }],
      }),
    ];
    try {
      validateFieldsIntegrity(fields);
      fail("expected validateFieldsIntegrity to throw");
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe("LOGIC_RULE_SELF_REFERENCE");
    }
  });

  it("throws HIDDEN_FIELD_CANNOT_BE_REQUIRED for a hide-action target that is required", () => {
    const fields = [
      field({
        fieldId: "a",
        logicRules: [{ targetFieldId: "b", operator: "equals", value: "x", action: "hide" }],
      }),
      field({ fieldId: "b", required: true }),
    ];
    try {
      validateFieldsIntegrity(fields);
      fail("expected validateFieldsIntegrity to throw");
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe("HIDDEN_FIELD_CANNOT_BE_REQUIRED");
    }
  });

  it("passes for a show-action target that is required (scoped to hide only)", () => {
    const fields = [
      field({
        fieldId: "a",
        logicRules: [{ targetFieldId: "b", operator: "equals", value: "x", action: "show" }],
      }),
      field({ fieldId: "b", required: true }),
    ];
    expect(() => validateFieldsIntegrity(fields)).not.toThrow();
  });
});

describe("createFormSchema / patchFormSchema - branding & settings", () => {
  const baseForm = {
    title: "A Valid Form",
    fields: [{ label: "Name", type: "short_text" as const, required: false }],
  };

  it("accepts a valid branding and settings payload", () => {
    const result = createFormSchema.safeParse({
      ...baseForm,
      branding: { primaryColor: "#FF5733", logoUrl: "https://example.com/logo.png" },
      settings: { successMessage: "Thanks!", responseLimitEnabled: true, responseLimit: 100 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid hex primaryColor", () => {
    const result = createFormSchema.safeParse({
      ...baseForm,
      branding: { primaryColor: "not-a-hex" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a successMessage over 500 characters", () => {
    const result = createFormSchema.safeParse({
      ...baseForm,
      settings: { successMessage: "a".repeat(501) },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive responseLimit", () => {
    const result = createFormSchema.safeParse({
      ...baseForm,
      settings: { responseLimit: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("patchFormSchema also accepts branding and settings", () => {
    const result = patchFormSchema.safeParse({
      branding: { coverImageUrl: "https://example.com/cover.png" },
      settings: { honeypotEnabled: true },
    });
    expect(result.success).toBe(true);
  });
});

describe("fieldSchema - url preview position, ratio and size", () => {
  const url = { label: "Site", type: "url", required: false };

  it("keeps the three settings on a url field", () => {
    const r = fieldSchema.safeParse({ ...url, urlPreviewPosition: "top", urlAspectRatio: "16:9", urlPreviewSize: "small" });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toMatchObject({ urlPreviewPosition: "top", urlAspectRatio: "16:9", urlPreviewSize: "small" });
  });

  it("rejects values outside the allowed lists", () => {
    expect(fieldSchema.safeParse({ ...url, urlPreviewPosition: "bottom" }).success).toBe(false);
    expect(fieldSchema.safeParse({ ...url, urlAspectRatio: "4:3" }).success).toBe(false);
    expect(fieldSchema.safeParse({ ...url, urlPreviewSize: "huge" }).success).toBe(false);
  });

  it("the settings are optional, so older forms stay valid", () => {
    expect(fieldSchema.safeParse(url).success).toBe(true);
  });
});
