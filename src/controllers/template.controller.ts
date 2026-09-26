import { Request, Response } from "express";
import Template from "../models/Template";
import { FormService } from "../services/form.service";
import Workspace from "../models/Workspace";
import mongoose from "mongoose";

const formService = new FormService();

const getWorkspaceIdFromUser = async (user: any): Promise<string> => {
  if (user.workspaceId) {
    return user.workspaceId._id ? user.workspaceId._id.toString() : user.workspaceId.toString();
  }
  const workspace = await Workspace.findOne({ owner: user._id });
  return workspace ? workspace._id.toString() : "";
};

// Shared helper — single source of truth for "fetch active templates + serialize"
const fetchActiveTemplates = async () => {
  const templates = await Template.find({ isActive: true });
  return templates.map((t) => ({
    _id: t._id.toString(),
    id: t._id.toString(),
    name: t.name,
    category: t.category,
    fields: t.fields,
    theme: t.theme,
    isActive: t.isActive,
  }));
};

// GET /api/templates - Returns all active templates (authenticated)
export const getTemplates = async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await fetchActiveTemplates();
    res.status(200).json({ success: true, data });
  } catch (error: any) {
    console.error("Error fetching templates:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching templates",
      error: error.message,
    });
  }
};

// GET /api/templates/public - Returns all active templates (unauthenticated, public gallery)
export const getPublicTemplates = async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await fetchActiveTemplates();
    res.status(200).json({ success: true, data });
  } catch (error: any) {
    console.error("Error fetching public templates:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching templates",
      error: error.message,
    });
  }
};

// POST /api/templates/:id/use - Use a template to create a new form
export const useTemplate = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id;
    const authReq = req as any;

    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
      });
      return;
    }

    // Reject use on non-existent template
    if (!id || typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(404).json({
        success: false,
        message: "Template not found",
      });
      return;
    }

    const template = await Template.findOne({ _id: id, isActive: true });
    if (!template) {
      res.status(404).json({
        success: false,
        message: "Template not found or is inactive",
      });
      return;
    }

    // Scope the new form to the caller's workspace (from the JWT)
    const workspaceId = await getWorkspaceIdFromUser(authReq.user);
    if (!workspaceId) {
      res.status(400).json({
        success: false,
        message: "No active workspace found for this user",
      });
      return;
    }

    // 1. Build field ID mapping (old fieldId/_id -> new fieldId)
    const fieldIdMap = new Map<string, string>();
    template.fields.forEach((f: any) => {
      const raw = f.toObject ? f.toObject() : f;
      const oldId = raw.fieldId || (raw._id ? raw._id.toString() : null);
      const newId = new mongoose.Types.ObjectId().toString();
      if (oldId) {
        fieldIdMap.set(oldId, newId);
      }
    });

    // 2. Map template fields with fresh fieldIds and re-mapped logicRules target/condition IDs
    const formFields = template.fields.map((f: any) => {
      const raw = f.toObject ? f.toObject() : f;
      const oldId = raw.fieldId || (raw._id ? raw._id.toString() : null);
      const newFieldId = (oldId && fieldIdMap.get(oldId)) || new mongoose.Types.ObjectId().toString();

      let updatedLogicRules: any[] | undefined = undefined;
      if (Array.isArray(raw.logicRules) && raw.logicRules.length > 0) {
        updatedLogicRules = raw.logicRules.map((rule: any) => {
          const ruleObj = rule.toObject ? rule.toObject() : { ...rule };
          const targetFieldId = fieldIdMap.get(ruleObj.targetFieldId) || ruleObj.targetFieldId;

          let condition = ruleObj.condition;
          if (condition) {
            const condObj = condition.toObject ? condition.toObject() : { ...condition };
            condition = {
              ...condObj,
              fieldId: fieldIdMap.get(condObj.fieldId) || condObj.fieldId,
            };
          }

          return {
            ...ruleObj,
            targetFieldId,
            condition,
          };
        });
      }

      return {
        fieldId: newFieldId,
        label: raw.label,
        type: raw.type,
        required: raw.required,
        deleted: raw.deleted ?? false,
        pageId: raw.pageId,
        placeholder: raw.placeholder,
        helpText: raw.helpText,
        minLength: raw.minLength,
        maxLength: raw.maxLength,
        pattern: raw.pattern,
        min: raw.min,
        max: raw.max,
        minDate: raw.minDate,
        maxDate: raw.maxDate,
        options: raw.options,
        maxFileSize: raw.maxFileSize,
        allowedMimeTypes: raw.allowedMimeTypes,
        logicRules: updatedLogicRules,
      };
    });

    const formDetails = {
      title: template.name,
      description: `Created from template: ${template.name}`,
      fields: formFields,
      pages: template.pages && template.pages.length > 0 ? template.pages : undefined,
      status: "draft" as const, // Default to draft, or active as per project standard (Form default is draft/active, let's keep draft since "a duplicate always starts as a draft" in duplicate controller)
    };

    // Create the new form
    const newForm = await formService.createForm(workspaceId, formDetails as any);

    res.status(201).json({
      success: true,
      message: "Form created from template successfully",
      data: newForm,
    });
  } catch (error: any) {
    console.error("Error using template:", error);
    res.status(500).json({
      success: false,
      message: "Error creating form from template",
      error: error.message,
    });
  }
};
