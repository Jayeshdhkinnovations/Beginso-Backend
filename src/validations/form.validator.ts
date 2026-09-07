import { z } from "zod";
import { IFormField, IFormPage } from "../models/Form";

const conditionSchema = z.object({
  fieldId: z.string().trim().min(1, "fieldId is required"),
  operator: z.literal("equals").default("equals"),
  value: z.string().trim().min(1, "Logic rule value is required"),
});

const logicRuleSchema = z
  .object({
    ruleId: z.string().trim().optional(),
    targetFieldId: z.string().trim().min(1, "targetFieldId is required"),
    action: z.enum(["show", "hide"]),
    condition: conditionSchema.optional(),
    operator: z.literal("equals").optional(),
    value: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.condition && !data.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either condition object or flat value must be provided",
        path: ["value"],
      });
    }
  });

const baseFieldSchema = z.object({
  fieldId: z.string().trim().optional(),
  pageId: z.string().trim().optional(),
  label: z
    .string()
    .trim()
    .min(1, "Field label must be at least 1 character")
    .max(100, "Field label cannot exceed 100 characters"),
  required: z.boolean().default(false),
  deleted: z.boolean().default(false),
  placeholder: z.string().trim().optional(),
  helpText: z.string().trim().optional(),
  logicRules: z.array(logicRuleSchema).optional(),
});

const shortTextObj = baseFieldSchema.extend({
  type: z.literal("short_text"),
  minLength: z.number().nonnegative("minLength must be non-negative").optional(),
  maxLength: z.number().int().positive("maxLength must be a positive integer").optional(),
});

const longTextObj = baseFieldSchema.extend({
  type: z.literal("long_text"),
  minLength: z.number().nonnegative("minLength must be non-negative").optional(),
  maxLength: z.number().int().positive("maxLength must be a positive integer").optional(),
});

const emailObj = baseFieldSchema.extend({
  type: z.literal("email"),
});

const phoneObj = baseFieldSchema.extend({
  type: z.literal("phone"),
  pattern: z.string().trim().optional(),
});

const numberObj = baseFieldSchema.extend({
  type: z.literal("number"),
  min: z.number().optional(),
  max: z.number().optional(),
});

const dateObj = baseFieldSchema.extend({
  type: z.literal("date"),
  minDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "minDate must be in YYYY-MM-DD format").optional(),
  maxDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "maxDate must be in YYYY-MM-DD format").optional(),
});

const dropdownObj = baseFieldSchema.extend({
  type: z.literal("dropdown"),
  options: z
    .array(z.string().trim().min(1, "Option value cannot be empty"))
    .min(1, "Dropdown must have at least one option"),
});

const multipleChoiceObj = baseFieldSchema.extend({
  type: z.literal("multiple_choice"),
  options: z
    .array(z.string().trim().min(1, "Option value cannot be empty"))
    .min(1, "Multiple choice must have at least one option"),
});

const checkboxObj = baseFieldSchema.extend({
  type: z.literal("checkbox"),
  options: z.array(z.string().trim().min(1, "Option value cannot be empty")).optional(),
});

const fileUploadObj = baseFieldSchema.extend({
  type: z.literal("file_upload"),
  maxFileSize: z.number().positive("maxFileSize must be positive").optional(), // in MB
  allowedMimeTypes: z.array(z.string().trim().min(1, "MIME type cannot be empty")).optional(),
});

export const fieldSchema = z
  .discriminatedUnion("type", [
    shortTextObj,
    longTextObj,
    emailObj,
    phoneObj,
    numberObj,
    dateObj,
    dropdownObj,
    multipleChoiceObj,
    checkboxObj,
    fileUploadObj,
  ])
  .superRefine((data, ctx) => {
    if (data.type === "short_text" || data.type === "long_text") {
      if (data.minLength !== undefined && data.maxLength !== undefined && data.minLength > data.maxLength) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "minLength cannot be greater than maxLength",
          path: ["minLength"],
        });
      }
    }
    if (data.type === "number") {
      if (data.min !== undefined && data.max !== undefined && data.min >= data.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "min must be less than max",
          path: ["min"],
        });
      }
    }
    if (data.type === "date") {
      if (data.minDate !== undefined && data.maxDate !== undefined) {
        const minD = new Date(data.minDate);
        const maxD = new Date(data.maxDate);
        if (isNaN(minD.getTime())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "minDate must be a valid date",
            path: ["minDate"],
          });
        }
        if (isNaN(maxD.getTime())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "maxDate must be a valid date",
            path: ["maxDate"],
          });
        }
        if (!isNaN(minD.getTime()) && !isNaN(maxD.getTime()) && minD > maxD) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "minDate cannot be greater than maxDate",
            path: ["minDate"],
          });
        }
      } else {
        if (data.minDate !== undefined && isNaN(new Date(data.minDate).getTime())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "minDate must be a valid date",
            path: ["minDate"],
          });
        }
        if (data.maxDate !== undefined && isNaN(new Date(data.maxDate).getTime())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "maxDate must be a valid date",
            path: ["maxDate"],
          });
        }
      }
    }
  });

const brandingSchema = z.object({
  primaryColor: z
    .string()
    .trim()
    .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, "primaryColor must be a valid hex color")
    .optional(),
  logoUrl: z.string().trim().optional(),
  coverImageUrl: z.string().trim().optional(),
});

const settingsSchema = z.object({
  successMessage: z.string().trim().max(500, "successMessage cannot exceed 500 characters").optional(),
  responseLimitEnabled: z.boolean().optional(),
  responseLimit: z.number().int().positive("responseLimit must be a positive integer").optional(),
  closeDate: z.string().trim().optional(),
  honeypotEnabled: z.boolean().optional(),
  layout: z.enum(["single_column", "two_column", "compact"]).optional(),
});

const formPageSchema = z.object({
  id: z.string().trim().min(1, "Page id is required"),
  order: z.number().int().nonnegative(),
  title: z.string().trim().optional(),
  description: z.string().trim().optional(),
});

export const createFormSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3, "Form title must be at least 3 characters")
      .max(100, "Form title cannot exceed 100 characters"),
    description: z.string().trim().max(500, "Description cannot exceed 500 characters").optional(),
    status: z.enum(["draft", "published", "closed"]).default("draft"),
    fields: z.array(fieldSchema).default([]),
    pages: z.array(formPageSchema).min(1, "Pages array must not be empty").optional(),
    slug: z.string().trim().optional(),
    publishedSlug: z.string().trim().optional(),
    branding: brandingSchema.optional(),
    settings: settingsSchema.optional(),
    workspaceId: z.string().trim().nullable().optional(),
    destinationWorkspaceId: z.string().trim().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.pages && data.pages.length > 0) {
      const pageIds = new Set(data.pages.map((p) => p.id));
      data.fields.forEach((field, index) => {
        if (field.pageId && !pageIds.has(field.pageId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Field pageId "${field.pageId}" does not exist in pages`,
            path: ["fields", index, "pageId"],
          });
        }
      });
    }
  });

export const patchFormSchema = z
  .object({
    title: z
      .string()
      .trim()
      .max(100, "Form title cannot exceed 100 characters")
      .optional(),
    description: z.string().trim().max(500, "Description cannot exceed 500 characters").optional(),
    status: z.enum(["draft", "published", "closed"]).optional(),
    fields: z.array(fieldSchema).optional(),
    pages: z.array(formPageSchema).min(1, "Pages array must not be empty").optional(),
    slug: z.string().trim().optional(),
    publishedSlug: z.string().trim().optional(),
    branding: brandingSchema.optional(),
    settings: settingsSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.pages && data.fields) {
      const pageIds = new Set(data.pages.map((p) => p.id));
      data.fields.forEach((field, index) => {
        if (field.pageId && !pageIds.has(field.pageId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Field pageId "${field.pageId}" does not exist in pages`,
            path: ["fields", index, "pageId"],
          });
        }
      });
    }
  });

function fieldValidationError(message: string, code: string): Error {
  const err = new Error(message);
  (err as any).statusCode = 400;
  (err as any).code = code;
  return err;
}

/**
 * Cross-field logic-rule integrity checks that need visibility of the full,
 * merged field list (not just whatever subset was in a given request body).
 */
export function validateFieldsIntegrity(fields: IFormField[], pages?: IFormPage[]): void {
  if (pages && pages.length > 0) {
    const pageIds = new Set(pages.map((p) => p.id));
    for (const field of fields) {
      if (field.deleted) continue;
      if (field.pageId && !pageIds.has(field.pageId)) {
        throw fieldValidationError(
          `Field "${field.label}" references a pageId "${field.pageId}" that does not exist in this form`,
          "INVALID_PAGE_REFERENCE"
        );
      }
    }
  }

  const allFieldIds = new Set(fields.map((f) => f.fieldId).filter(Boolean));
  const hideTargets = new Set<string>();

  for (const field of fields) {
    if (field.deleted || !field.logicRules?.length) continue;

    for (const rule of field.logicRules) {
      if (!rule.targetFieldId || !allFieldIds.has(rule.targetFieldId)) {
        throw fieldValidationError(
          `Logic rule on field "${field.label}" references a field that does not exist on this form`,
          "LOGIC_RULE_INVALID_TARGET"
        );
      }
      if (rule.targetFieldId === field.fieldId) {
        throw fieldValidationError(
          `Logic rule on field "${field.label}" cannot target itself`,
          "LOGIC_RULE_SELF_REFERENCE"
        );
      }
      if (rule.action === "hide") {
        hideTargets.add(rule.targetFieldId);
      }
    }
  }

  for (const field of fields) {
    if (field.deleted) continue;
    if (field.fieldId && hideTargets.has(field.fieldId) && field.required) {
      throw fieldValidationError(
        `Field "${field.label}" is conditionally hidden by a logic rule and cannot be required`,
        "HIDDEN_FIELD_CANNOT_BE_REQUIRED"
      );
    }
  }
}

export const getHiddenFieldIds = (fields: any[], answers: Record<string, any>): Set<string> => {
  const hiddenFieldIds = new Set<string>();

  // 1. Map fields by fieldId
  const fieldMap = new Map<string, any>();
  for (const f of fields) {
    if (f.fieldId) {
      fieldMap.set(f.fieldId, f);
    }
  }

  // 2. Identify all logic rules targeting each field
  const showRulesMap = new Map<string, Array<{ rule: any; sourceField: any }>>();
  const hideRulesMap = new Map<string, Array<{ rule: any; sourceField: any }>>();
  const hasShowRules = new Set<string>();

  for (const f of fields) {
    if (f.deleted || !f.logicRules) continue;
    for (const rule of f.logicRules) {
      const targetId = rule.targetFieldId;
      if (!targetId) continue;

      if (rule.action === "show") {
        hasShowRules.add(targetId);
        if (!showRulesMap.has(targetId)) showRulesMap.set(targetId, []);
        showRulesMap.get(targetId)!.push({ rule, sourceField: f });
      } else if (rule.action === "hide") {
        if (!hideRulesMap.has(targetId)) hideRulesMap.set(targetId, []);
        hideRulesMap.get(targetId)!.push({ rule, sourceField: f });
      }
    }
  }

  // Helper to evaluate a single rule's condition
  const isConditionMet = (rule: any, sourceField: any): boolean => {
    let srcField = sourceField;
    if (rule.condition && rule.condition.fieldId) {
      srcField = fieldMap.get(rule.condition.fieldId);
    }
    if (!srcField) return false;

    const val = (srcField.fieldId && answers[srcField.fieldId] !== undefined) ? answers[srcField.fieldId] : answers[srcField.label];
    if (val === undefined || val === null) return false;

    const targetVal = rule.condition ? rule.condition.value : rule.value;
    return String(val) === String(targetVal);
  };

  // 3. Determine visibility for each field
  for (const f of fields) {
    const fieldId = f.fieldId;
    if (!fieldId) continue;

    // A field targeted by at least one 'show' rule is hidden by default
    let isVisible = true;
    if (hasShowRules.has(fieldId)) {
      const rules = showRulesMap.get(fieldId) || [];
      isVisible = rules.some(({ rule, sourceField }) => isConditionMet(rule, sourceField));
    }

    // A field targeted by a met 'hide' rule becomes hidden
    const hideRules = hideRulesMap.get(fieldId) || [];
    const isHidden = !isVisible || hideRules.some(({ rule, sourceField }) => isConditionMet(rule, sourceField));

    if (isHidden) {
      hiddenFieldIds.add(fieldId);
    }
  }

  return hiddenFieldIds;
};
