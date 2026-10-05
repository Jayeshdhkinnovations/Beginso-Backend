import { Request, Response } from "express";
import { recordEvent } from "../services/event.service";
import Template from "../models/Template";
import Form from "../models/Form";
import { FormService } from "../services/form.service";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { getVerifiedWorkspaceId } from "../utils/requestContext";
import { hasPermission } from "../middleware/permission.middleware";
import mongoose from "mongoose";
import { getTemplateDescription, getTemplateSettings } from "../utils/templateDefaults";

const formService = new FormService();

const BUILT_IN = { $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }] };

// Shared helper - single source of truth for "fetch active templates + serialize".
// Sprint 13 (B6.1): two sources. Built-in Beginso templates are visible to everyone; a workspace's own
// templates are visible ONLY to that workspace (`workspaceId` passed in, already authorized by the route).
// The public gallery passes nothing, so it can never leak a workspace's templates.
const fetchActiveTemplates = async (workspaceId?: string | null) => {
  const query: any = workspaceId
    ? { isActive: true, $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }, { workspaceId }] }
    : { isActive: true, ...BUILT_IN };
  const templates = await Template.find(query);
  return templates.map((t) => ({
    _id: t._id.toString(),
    id: t._id.toString(),
    name: t.name,
    description: t.description?.trim() || getTemplateDescription(t.name),
    settings: { ...getTemplateSettings(), ...t.toObject().settings },
    category: t.category,
    fields: t.fields,
    theme: t.theme,
    isActive: t.isActive,
    source: t.workspaceId ? ("workspace" as const) : ("beginso" as const),
  }));
};

// GET /api/templates - Returns all active templates (authenticated)
export const getTemplates = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as any;
    // Personal context has no workspace, so only the built-in templates apply there (A4.1).
    const personal = authReq.explicitPersonalContext === true || !authReq.workspaceId;
    const data = await fetchActiveTemplates(personal ? null : String(authReq.workspaceId));
    res.status(200).json({ success: true, data });
  } catch (error: any) {
    console.error("Error fetching templates:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching templates",
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

    // A workspace template is only usable by members of the workspace that owns it. Anyone else gets the
    // same 404 as a template that does not exist, so ids cannot be probed.
    if (template.workspaceId && authReq.user.role !== "super_admin") {
      const member = await Membership.exists({ userId: authReq.user._id, workspaceId: template.workspaceId });
      const owner = await Workspace.exists({ _id: template.workspaceId, owner: authReq.user._id });
      if (!member && !owner) {
        res.status(404).json({ success: false, message: "Template not found or is inactive" });
        return;
      }
    }

    // Explicit body destinations are authorized here, against the actual target.
    // The route retains legacy permission middleware when no destination is given.
    let workspaceId: string | null;
    const destination = req.body?.destinationWorkspaceId;
    if (destination !== undefined) {
      if (destination === null) {
        workspaceId = null;
      } else {
        if (typeof destination !== "string" || !mongoose.Types.ObjectId.isValid(destination.trim())) {
          res.status(400).json({ success: false, message: "Invalid destinationWorkspaceId format" });
          return;
        }
        const target = await Workspace.findById(destination.trim());
        if (!target || target.status === "deleted") {
          res.status(404).json({ success: false, message: "Workspace not found" });
          return;
        }
        if (target.status === "suspended") {
          res.status(403).json({ success: false, message: "Workspace is suspended" });
          return;
        }
        if (authReq.user.role !== "super_admin") {
          const membership = await Membership.findOne({ userId: authReq.user._id, workspaceId: target._id });
          const role = membership?.role || (target.owner.toString() === authReq.user._id.toString() ? "owner" : null);
          if (!role || !hasPermission(role, "forms:create")) {
            res.status(403).json({
              success: false,
              message: "Forbidden: Cannot create forms in this workspace",
              error: { code: role ? "FORBIDDEN_INSUFFICIENT_PERMISSIONS" : "FORBIDDEN_WORKSPACE_ACCESS" },
            });
            return;
          }
        }
        workspaceId = target._id.toString();
      }
    } else {
      workspaceId = await getVerifiedWorkspaceId(req);
      if (!workspaceId) {
        res.status(400).json({ success: false, message: "No active workspace found for this user" });
        return;
      }
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
      createdBy: authReq.user._id,
      title: template.name,
      description: `Created from template: ${template.name}`,
      fields: formFields,
      pages: template.pages && template.pages.length > 0 ? template.pages : undefined,
      // A workspace template was made from a real form: carry its settings and theme over (Sprint 13, B6.4).
      // Built-in templates keep their long-standing behaviour of supplying fields and pages only.
      ...(template.workspaceId
        ? { settings: (template.toObject() as any).settings, branding: (template.toObject() as any).branding }
        : {}),
      status: "draft" as const, // Default to draft, or active as per project standard (Form default is draft/active, let's keep draft since "a duplicate always starts as a draft" in duplicate controller)
    };

    // Create the new form
    const newForm = await formService.createForm(workspaceId, formDetails as any);
    await recordEvent(req, newForm.workspaceId, "form.create", { id: newForm._id, type: "form", label: newForm.title }, { templateId: id });

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
    });
  }
};

// POST /api/templates   body: { formId, name?, description?, category? }
// Sprint 13, BE 0.13 (B6.4): publish a form to the workspace's own templates. Editor and above (Reviewers
// cannot create forms, so cannot create templates) - the route enforces forms:create. The template is a
// SNAPSHOT, not a link: it carries fields, logic, pages, settings and theme, and never responses, notes,
// assignees, tags, the share link or analytics.
export const publishTemplate = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as any;
    if (authReq.explicitPersonalContext === true || !authReq.workspaceId) {
      res.status(400).json({ success: false, message: "Templates belong to a workspace - switch to one first" });
      return;
    }
    const workspaceId = String(authReq.workspaceId);
    const { formId, name, description, category } = req.body || {};
    if (!formId || typeof formId !== "string" || !mongoose.Types.ObjectId.isValid(formId)) {
      res.status(400).json({ success: false, message: "formId is required" });
      return;
    }
    // The form must live in THIS workspace (and, via the Form query hook, must not be in Trash).
    const form = await Form.findOne({ _id: formId, workspaceId });
    if (!form) {
      res.status(404).json({ success: false, message: "Form not found" });
      return;
    }

    const formObj: any = form.toObject();
    const settings = { ...(formObj.settings || {}) };
    delete settings.closeDate; // a date belongs to one form's run, not to a reusable starting point

    const template = await Template.create({
      name: String(name || form.title).trim().slice(0, 100) || form.title,
      description: typeof description === "string" ? description.trim().slice(0, 500) : form.description || "",
      category: typeof category === "string" && category.trim() ? category.trim() : "Workspace",
      theme: "workspace",
      isActive: true,
      fields: (formObj.fields || []).filter((f: any) => !f.deleted),
      pages: formObj.pages || [],
      settings,
      branding: formObj.branding || {},
      workspaceId,
      createdBy: authReq.user._id,
      sourceFormId: form._id,
    });

    await recordEvent(req, workspaceId, "template.publish", { id: template._id, type: "template", label: template.name }, { sourceFormId: String(form._id) });
    res.status(201).json({
      success: true,
      data: { _id: template._id.toString(), id: template._id.toString(), name: template.name, source: "workspace" },
    });
  } catch (error: any) {
    console.error("Error publishing template:", error);
    res.status(500).json({ success: false, message: "Error publishing template" });
  }
};

// DELETE /api/templates/:id - remove one of the workspace's own templates (Owner/Admin). Built-in templates
// are not removable here.
export const removeTemplate = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as any;
    const id = req.params.id;
    if (!id || typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) {
      res.status(404).json({ success: false, message: "Template not found" });
      return;
    }
    const template = await Template.findOne({ _id: id, workspaceId: { $ne: null } });
    if (!template || !template.workspaceId) {
      res.status(404).json({ success: false, message: "Template not found" });
      return;
    }
    if (authReq.user.role !== "super_admin") {
      const membership = await Membership.findOne({ userId: authReq.user._id, workspaceId: template.workspaceId });
      const owner = await Workspace.exists({ _id: template.workspaceId, owner: authReq.user._id });
      const role = membership?.role || (owner ? "owner" : null);
      if (!role) {
        res.status(404).json({ success: false, message: "Template not found" });
        return;
      }
      if (!hasPermission(role, "templates:create")) {
        res.status(403).json({
          success: false,
          message: "Forbidden: only an Owner or Admin can remove a workspace template",
          error: { code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS", message: "Forbidden: only an Owner or Admin can remove a workspace template" },
        });
        return;
      }
    }
    await Template.deleteOne({ _id: template._id });
    await recordEvent(req, template.workspaceId, "template.remove", { id: template._id, type: "template", label: template.name });
    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error("Error removing template:", error);
    res.status(500).json({ success: false, message: "Error removing template" });
  }
};
