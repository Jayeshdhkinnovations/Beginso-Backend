import { FormRepository } from "../repositories/form.repository";
import Form, { IForm, IFormField } from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";
import { getUploadDir } from "../controllers/upload.controller";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { nanoid } from "nanoid";
import { validateFieldsIntegrity, getHiddenFieldIds } from "../validations/form.validator";

const CHOICE_FIELD_TYPES = ["dropdown", "multiple_choice"];
const MAX_SLUG_ATTEMPTS = 5;

export class FormValidationError extends Error {
  statusCode = 422;
  errors: Array<{ field: string; message: string }>;

  constructor(errors: Array<{ field: string; message: string }>) {
    super("Validation failed");
    this.name = "FormValidationError";
    this.errors = errors;
  }
}

export class FormService {
  private formRepository = new FormRepository();

  private processFieldsUpdate(existingFields: IFormField[], incomingFields: any[]): { fields: IFormField[], fieldsChanged: boolean } {
    let fieldsChanged = false;
    const existingMap = new Map<string, IFormField>();
    for (const f of existingFields) {
      if (f.fieldId) {
        existingMap.set(f.fieldId, f);
      }
    }

    const updatedFields: IFormField[] = [];
    const incomingFieldIds = new Set<string>();

    for (const incoming of incomingFields) {
      let fieldId = incoming.fieldId;
      if (!fieldId) {
        fieldId = new mongoose.Types.ObjectId().toString();
        incoming.fieldId = fieldId;
        fieldsChanged = true;
      }

      incomingFieldIds.add(fieldId);

      const existing = existingMap.get(fieldId);
      if (existing) {
        // Convert to plain object to clear Mongoose subdocument properties
        const existingObj = JSON.parse(JSON.stringify(existing));
        
        // Remove internal fields for comparison
        const { _id, deleted, ...cleanExisting } = existingObj as any;
        const { _id: incomingId, deleted: incomingDeleted, ...cleanIncoming } = incoming;

        const hasChanges = !deepEqual(cleanExisting, cleanIncoming) || existing.deleted !== (incoming.deleted ?? false);
        if (hasChanges) {
          fieldsChanged = true;
        }

        updatedFields.push({
          ...existingObj,
          ...incoming,
          fieldId, // maintain immutable fieldId
          deleted: incoming.deleted ?? existing.deleted ?? false,
        });
      } else {
        fieldsChanged = true;
        updatedFields.push({
          ...incoming,
          fieldId,
          deleted: incoming.deleted ?? false,
        });
      }
    }

    // Soft delete: Keep existing fields not in the incoming list, marked deleted: true
    for (const existing of existingFields) {
      if (existing.fieldId && !incomingFieldIds.has(existing.fieldId)) {
        const existingObj = JSON.parse(JSON.stringify(existing));
        if (!existingObj.deleted) {
          fieldsChanged = true;
          existingObj.deleted = true;
        }
        updatedFields.push(existingObj);
      }
    }

    return { fields: updatedFields, fieldsChanged };
  }

  async createForm(workspaceId: string | null, formDetails: Partial<IForm>): Promise<IForm> {
    // Seed default page if none provided
    if (!formDetails.pages || formDetails.pages.length === 0) {
      formDetails.pages = [
        {
          id: new mongoose.Types.ObjectId().toString(),
          order: 0,
          title: formDetails.title || "Form",
          description: formDetails.description || "",
        },
      ];
    }

    if (formDetails.fields) {
      const defaultPageId = formDetails.pages[0].id;
      formDetails.fields = formDetails.fields.map((f: any) => {
        if (!f.fieldId) {
          f.fieldId = new mongoose.Types.ObjectId().toString();
        }
        if (!f.pageId) {
          f.pageId = defaultPageId;
        }
        f.deleted = f.deleted ?? false;
        return f;
      });
      validateFieldsIntegrity(formDetails.fields, formDetails.pages);
    }
    if (!formDetails.slug) {
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const base = formDetails.title ? formDetails.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "form";
      formDetails.slug = `${base}-${randomSuffix}`.replace(/-+/g, "-");
    }
    formDetails.schemaVersion = 1;
    return await this.formRepository.create(workspaceId, formDetails);
  }

  async getFormById(formId: string, workspaceId: string, isGrant?: boolean): Promise<IForm> {
    const exists = await this.formRepository.findById(formId);
    if (!exists) {
      const err = new Error("Form not found");
      (err as any).statusCode = 404;
      throw err;
    }
    if (isGrant || !workspaceId) {
      return exists;
    }
    const form = await this.formRepository.findById(formId, workspaceId);
    if (!form) {
      const err = new Error("Forbidden: You do not own this form's workspace");
      (err as any).statusCode = 403;
      throw err;
    }
    return form;
  }

  async listForms(
    workspaceId: string,
    options: {
      search?: string;
      status?: string;
      page?: number;
      limit?: number;
      personalUserId?: string;
    }
  ) {
    const page = Number(options.page) || 1;
    const limit = Number(options.limit) || 10;
    const skip = (page - 1) * limit;

    const query: any = workspaceId
      ? { workspaceId }
      : options.personalUserId
      ? { workspaceId: null, createdBy: options.personalUserId }
      : { workspaceId };

    if (options.status) {
      query.status = options.status;
    }

    if (options.search) {
      query.title = { $regex: options.search, $options: "i" };
    }

    const [forms, total] = await Promise.all([
      this.formRepository.findWithPagination(query, skip, limit, workspaceId),
      this.formRepository.count(query, workspaceId),
    ]);

    const formsWithCount = await Promise.all(
      forms.map(async (f) => {
        const doc = f.toObject ? f.toObject() : f;
        const responseCount = await ResponseModel.countDocuments({ formId: doc._id });
        return {
          ...doc,
          responseCount,
        };
      })
    );

    const pages = Math.ceil(total / limit);

    return {
      forms: formsWithCount,
      total,
      page,
      limit,
      pages,
    };
  }

  async updateForm(
    formId: string,
    workspaceId: string,
    updateDetails: Partial<IForm>
  ): Promise<IForm> {
    if (updateDetails.pages && updateDetails.pages.length === 0) {
      const err = new Error("Pages array must not be empty");
      (err as any).statusCode = 400;
      throw err;
    }

    const existing = await this.getFormById(formId, workspaceId);
    const pages = updateDetails.pages || existing.pages || [];

    if (updateDetails.fields) {
      const { fields, fieldsChanged } = this.processFieldsUpdate(existing.fields, updateDetails.fields);
      updateDetails.fields = fields;
      validateFieldsIntegrity(fields, pages);
      if (fieldsChanged) {
        updateDetails.schemaVersion = (existing.schemaVersion || 1) + 1;
      } else {
        updateDetails.schemaVersion = existing.schemaVersion || 1;
      }
    }

    const updated = await this.formRepository.update(formId, workspaceId, updateDetails);
    if (!updated) {
      const err = new Error("Form not found for update");
      (err as any).statusCode = 404;
      throw err;
    }
    return updated;
  }

  async patchForm(
    formId: string,
    workspaceId: string,
    patchDetails: Partial<IForm>
  ): Promise<IForm> {
    if (patchDetails.pages && patchDetails.pages.length === 0) {
      const err = new Error("Pages array must not be empty");
      (err as any).statusCode = 400;
      throw err;
    }

    const existing = await this.getFormById(formId, workspaceId);
    const pages = patchDetails.pages || existing.pages || [];

    if (patchDetails.fields) {
      const { fields, fieldsChanged } = this.processFieldsUpdate(existing.fields, patchDetails.fields);
      patchDetails.fields = fields;
      validateFieldsIntegrity(fields, pages);
      if (fieldsChanged) {
        patchDetails.schemaVersion = (existing.schemaVersion || 1) + 1;
      } else {
        patchDetails.schemaVersion = existing.schemaVersion || 1;
      }
    }

    const updated = await this.formRepository.update(formId, workspaceId, patchDetails);
    if (!updated) {
      const err = new Error("Form not found for update");
      (err as any).statusCode = 404;
      throw err;
    }
    return updated;
  }

  async publishForm(
    formId: string,
    workspaceId: string,
    extraPatch?: Partial<IForm>
  ): Promise<IForm> {
    if (extraPatch && extraPatch.pages && extraPatch.pages.length === 0) {
      const err = new Error("Pages array must not be empty");
      (err as any).statusCode = 400;
      throw err;
    }

    const existing = await this.getFormById(formId, workspaceId);
    const pages = (extraPatch && extraPatch.pages) || existing.pages || [];

    let fields = existing.fields;
    const updateDetails: Partial<IForm> = {};

    if (extraPatch) {
      if (extraPatch.title !== undefined) updateDetails.title = extraPatch.title;
      if (extraPatch.description !== undefined) updateDetails.description = extraPatch.description;
      if (extraPatch.fields) {
        const { fields: mergedFields, fieldsChanged } = this.processFieldsUpdate(existing.fields, extraPatch.fields);
        fields = mergedFields;
        updateDetails.fields = mergedFields;
        if (fieldsChanged) {
          updateDetails.schemaVersion = (existing.schemaVersion || 1) + 1;
        }
      }
      if (extraPatch.pages) {
        updateDetails.pages = extraPatch.pages;
      }
    }

    validateFieldsIntegrity(fields, pages);

    const visibleFields = fields.filter((f) => !f.deleted);

    if (visibleFields.length === 0) {
      const err = new Error("Form must have at least one field to be published");
      (err as any).statusCode = 400;
      (err as any).code = "FORM_HAS_NO_FIELDS";
      throw err;
    }

    for (const field of visibleFields) {
      if (CHOICE_FIELD_TYPES.includes(field.type) && (!field.options || field.options.length === 0)) {
        const err = new Error(`Field "${field.label}" must have at least one option to be published`);
        (err as any).statusCode = 400;
        (err as any).code = "CHOICE_FIELD_HAS_NO_OPTIONS";
        throw err;
      }
    }

    // Reuse existing slug on re-publish; only generate a new one on first publish
    const publishedSlug = existing.publishedSlug || await this.generateUniqueSlug();

    updateDetails.status = "published";
    updateDetails.publishedAt = existing.publishedAt || new Date();
    updateDetails.publishedSlug = publishedSlug;

    const updated = await this.formRepository.update(formId, workspaceId, updateDetails);
    if (!updated) {
      const err = new Error("Form not found for update");
      (err as any).statusCode = 404;
      throw err;
    }
    return updated;
  }

  async closeForm(formId: string, workspaceId: string): Promise<IForm> {
    await this.getFormById(formId, workspaceId);

    const updated = await this.formRepository.update(formId, workspaceId, { status: "closed" });
    if (!updated) {
      const err = new Error("Form not found for update");
      (err as any).statusCode = 404;
      throw err;
    }
    return updated;
  }

  private async generateUniqueSlug(): Promise<string> {
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const candidate = nanoid(10);
      const existing = await this.formRepository.findOne({ publishedSlug: candidate });
      if (!existing) {
        return candidate;
      }
    }
    const err = new Error("Could not generate a unique slug, please try again");
    (err as any).statusCode = 500;
    throw err;
  }

  async deleteForm(formId: string, workspaceId: string): Promise<void> {
    const form = await this.getFormById(formId, workspaceId);

    // Find all responses associated with this form
    const responses = await ResponseModel.find({ formId });

    // Collect all associated file names to delete
    const fileNames = new Set<string>();

    // 1. Check form branding
    if (form.branding?.logoUrl) {
      fileNames.add(path.basename(form.branding.logoUrl));
    }
    if (form.branding?.coverImageUrl) {
      fileNames.add(path.basename(form.branding.coverImageUrl));
    }

    // 2. Check response answers for file uploads
    const fileFields = form.fields.filter(f => f.type === "file_upload");
    for (const resDoc of responses) {
      if (resDoc.answers) {
        for (const field of fileFields) {
          const answer = resDoc.answers[field.label];
          if (answer && typeof answer === "object" && answer.fileName) {
            fileNames.add(path.basename(answer.fileName));
          }
        }
      }
    }

    // 3. Find and delete corresponding Upload metadata & physical files from disk
    if (fileNames.size > 0) {
      const uniqueNames = Array.from(fileNames);
      const uploads = await Upload.find({ path: { $in: uniqueNames } });

      const uploadDir = getUploadDir();
      for (const upload of uploads) {
        const filePath = path.resolve(uploadDir, upload.path);
        if (filePath.startsWith(path.resolve(uploadDir)) && fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (err) {
            console.error("Failed to delete physical file during form cascade delete:", err);
          }
        }
      }

      await Upload.deleteMany({ _id: { $in: uploads.map(u => u._id) } });
    }

    // 4. Delete all associated responses from MongoDB
    await ResponseModel.deleteMany({ formId });

    // 5. Delete the form from MongoDB
    await this.formRepository.delete(formId, workspaceId);
  }

  async submitForm(formId: string, answers: Record<string, any>, ipHash?: string, responseId?: string) {
    const form = await this.formRepository.findById(formId);
    if (!form) {
      const err = new Error("Form not found");
      (err as any).statusCode = 404;
      throw err;
    }

    // Enforce close-date and response-limit availability check for all submission routes
    await this.checkFormAvailability(form);

    // Dynamic validation logic against form fields
    const hiddenFieldIds = getHiddenFieldIds(form.fields, answers);
    const validationErrors: Array<{ field: string; message: string }> = [];

    for (const field of form.fields) {
      if (field.deleted) {
        continue;
      }

      // Skip conditionally hidden fields from validation (hidden fields are never required)
      if (field.fieldId && hiddenFieldIds.has(field.fieldId)) {
        continue;
      }

      let value = (field.fieldId && answers[field.fieldId] !== undefined) ? answers[field.fieldId] : answers[field.label];
      if (field.type === "file_upload") {
        value = answers[field.label];
      }
      
      // 1. Required check
      if (field.required && (value === undefined || value === null || value === "")) {
        validationErrors.push({ field: field.label, message: `Field "${field.label}" is required.` });
        continue;
      }

      if (value !== undefined && value !== null && value !== "") {
        // 2. Validate Text and Long Text shapes (minLength, maxLength)
        if (field.type === "short_text" || field.type === "long_text") {
          if (typeof value !== "string") {
            validationErrors.push({ field: field.label, message: `Field "${field.label}" must be a string.` });
            continue;
          }
          if (field.minLength !== undefined && value.length < field.minLength) {
            validationErrors.push({ field: field.label, message: `Field "${field.label}" must be at least ${field.minLength} characters.` });
          }
          if (field.maxLength !== undefined && value.length > field.maxLength) {
            validationErrors.push({ field: field.label, message: `Field "${field.label}" cannot exceed ${field.maxLength} characters.` });
          }
        }

        // 3. Validate Email shape
        if (field.type === "email") {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (typeof value !== "string" || !emailRegex.test(value)) {
            validationErrors.push({ field: field.label, message: `Field "${field.label}" must be a valid email address.` });
          }
        }

        // 4. Validate Phone shape (with optional regex pattern)
        if (field.type === "phone") {
          if (typeof value !== "string") {
            validationErrors.push({ field: field.label, message: `Field "${field.label}" must be a string.` });
            continue;
          }
          if (field.pattern) {
            const regex = new RegExp(field.pattern);
            if (!regex.test(value)) {
              validationErrors.push({ field: field.label, message: `Field "${field.label}" must match format pattern: ${field.pattern}.` });
            }
          }
        }

        // 5. Validate Number shape (min, max)
        if (field.type === "number") {
          const numValue = Number(value);
          if (isNaN(numValue)) {
            validationErrors.push({ field: field.label, message: `Field "${field.label}" must be a valid number.` });
            continue;
          }
          if (field.min !== undefined && numValue < field.min) {
            validationErrors.push({ field: field.label, message: `Field "${field.label}" must be at least ${field.min}.` });
          }
          if (field.max !== undefined && numValue > field.max) {
            validationErrors.push({ field: field.label, message: `Field "${field.label}" cannot exceed ${field.max}.` });
          }
        }

        // 6. Validate Date shape (minDate, maxDate)
        if (field.type === "date") {
          const dateValue = new Date(value);
          if (isNaN(dateValue.getTime())) {
            validationErrors.push({ field: field.label, message: `Field "${field.label}" must be a valid date.` });
            continue;
          }
          if (field.minDate) {
            const minDateVal = new Date(field.minDate);
            if (!isNaN(minDateVal.getTime()) && dateValue < minDateVal) {
              validationErrors.push({ field: field.label, message: `Field "${field.label}" date cannot be earlier than ${field.minDate}.` });
            }
          }
          if (field.maxDate) {
            const maxDateVal = new Date(field.maxDate);
            if (!isNaN(maxDateVal.getTime()) && dateValue > maxDateVal) {
              validationErrors.push({ field: field.label, message: `Field "${field.label}" date cannot be later than ${field.maxDate}.` });
            }
          }
        }

        // 7. Validate Dropdown and Multiple Choice (options check)
        if (field.type === "dropdown" || field.type === "multiple_choice") {
          if (!field.options || !field.options.includes(value)) {
            validationErrors.push({
              field: field.label,
              message: `Value "${value}" is not a valid option for field "${field.label}". Valid options: ${(field.options || []).join(", ")}`
            });
          }
        }

        // 8. Validate Checkbox options (single or multi-select option checks)
        if (field.type === "checkbox") {
          if (field.options && field.options.length > 0) {
            const selectedArr = Array.isArray(value) ? value : [value];
            for (const val of selectedArr) {
              if (!field.options.includes(val)) {
                validationErrors.push({
                  field: field.label,
                  message: `Value "${val}" is not a valid option for checkbox field "${field.label}".`
                });
              }
            }
          } else {
            if (typeof value !== "boolean" && value !== "true" && value !== "false" && value !== true && value !== false) {
              validationErrors.push({ field: field.label, message: `Field "${field.label}" must be a boolean (true/false).` });
            }
          }
        }

        // 9. Validate File Upload settings (maxFileSize, allowedMimeTypes check)
        if (field.type === "file_upload") {
          if (typeof value !== "object" || !value.fileName || value.fileSize === undefined || !value.mimeType) {
            validationErrors.push({
              field: field.label,
              message: `Field "${field.label}" must be a valid file upload payload containing fileName, fileSize (bytes), and mimeType.`
            });
            continue;
          }
          if (field.maxFileSize !== undefined) {
            const fileSizeMB = value.fileSize / (1024 * 1024);
            if (fileSizeMB > field.maxFileSize) {
              validationErrors.push({
                field: field.label,
                message: `Field "${field.label}" file size exceeds the limit of ${field.maxFileSize} MB.`
              });
            }
          }
          if (field.allowedMimeTypes && field.allowedMimeTypes.length > 0) {
            if (!field.allowedMimeTypes.includes(value.mimeType)) {
              validationErrors.push({
                field: field.label,
                message: `Field "${field.label}" file type "${value.mimeType}" is not allowed. Allowed types: ${field.allowedMimeTypes.join(", ")}.`
              });
            }
          }
        }
      }
    }

    if (validationErrors.length > 0) {
      throw new FormValidationError(validationErrors);
    }

    // Strip hidden fields from being persisted
    for (const field of form.fields) {
      if (field.fieldId && hiddenFieldIds.has(field.fieldId)) {
        delete answers[field.fieldId];
        delete answers[field.label];
      }
    }

    const newResponse = await ResponseModel.create({
      _id: responseId || new mongoose.Types.ObjectId(),
      formId,
      answers,
      submittedAt: new Date(),
      ipHash,
    });

    // Check if response limit has been reached and flip status to closed
    if (form.settings?.responseLimitEnabled && form.settings.responseLimit !== undefined) {
      const currentCount = await ResponseModel.countDocuments({ formId });
      if (currentCount >= form.settings.responseLimit) {
        await Form.updateOne({ _id: form._id }, { status: "closed" });
      }
    }

    return newResponse;
  }

  async getSubmissions(formId: string, workspaceId: string, isGrant?: boolean) {
    await this.getFormById(formId, workspaceId, isGrant);
    return await ResponseModel.find({ formId });
  }

  async duplicateForm(formId: string, workspaceId: string): Promise<IForm> {
    const originalForm = await this.getFormById(formId, workspaceId);

    // Deep copy fields
    const duplicatedFields = originalForm.fields.map((field) => {
      const fieldObj = JSON.parse(JSON.stringify(field));
      // Keep field structure intact (including labels, types, properties, fieldId)
      return fieldObj;
    });

    // Create a fresh unique slug
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const originalSlug = originalForm.slug || originalForm.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const freshSlug = `copy-of-${originalSlug}-${randomSuffix}`.replace(/-+/g, "-");

    // Construct duplicate form object
    const duplicateData = {
      title: `Copy of ${originalForm.title}`,
      description: originalForm.description,
      workspaceId: originalForm.workspaceId,
      status: "draft",
      fields: duplicatedFields,
      schemaVersion: 1,
      slug: freshSlug,
      // Do NOT carry over a publishedSlug or publishedAt — a duplicate always starts as a draft
      publishedSlug: undefined,
    };

    return await this.formRepository.create(workspaceId, duplicateData as any);
  }

  private async checkFormAvailability(form: IForm, isPublicRoute: boolean = false): Promise<void> {
    if (form.status === "closed") {
      const err = new Error("Form not found");
      (err as any).statusCode = 404;
      throw err;
    }
    if (isPublicRoute && form.status !== "published") {
      const err = new Error("Form not found");
      (err as any).statusCode = 404;
      throw err;
    }

    let shouldClose = false;

    // 1. Check closeDate
    if (form.settings?.closeDate) {
      const closeTime = new Date(form.settings.closeDate).getTime();
      const now = new Date().getTime();
      if (!isNaN(closeTime) && now > closeTime) {
        shouldClose = true;
      }
    }

    // 2. Check responseLimit
    if (!shouldClose && form.settings?.responseLimitEnabled && form.settings.responseLimit !== undefined) {
      const responseCount = await ResponseModel.countDocuments({ formId: form._id });
      if (responseCount >= form.settings.responseLimit) {
        shouldClose = true;
      }
    }

    if (shouldClose) {
      form.status = "closed";
      await Form.updateOne({ _id: form._id }, { status: "closed" });

      const err = new Error("Form not found");
      (err as any).statusCode = 404;
      throw err;
    }
  }

  async getPublicFormBySlug(slug: string): Promise<IForm> {
    if (!slug || typeof slug !== "string") {
      const err = new Error("Form not found");
      (err as any).statusCode = 404;
      throw err;
    }
    const form = await this.formRepository.findOne({ publishedSlug: slug });
    if (!form) {
      const err = new Error("Form not found");
      (err as any).statusCode = 404;
      throw err;
    }
    await this.checkFormAvailability(form, true);
    return form;
  }
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    const keysA = Object.keys(a).filter(k => a[k] !== undefined && a[k] !== null && (Array.isArray(a[k]) ? a[k].length > 0 : true));
    const keysB = Object.keys(b).filter(k => b[k] !== undefined && b[k] !== null && (Array.isArray(b[k]) ? b[k].length > 0 : true));
    
    const setA = new Set(keysA);
    const setB = new Set(keysB);
    if (setA.size !== setB.size) return false;
    for (const key of setA) {
      if (!setB.has(key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

