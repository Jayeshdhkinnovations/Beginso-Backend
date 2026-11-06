import { Request, Response } from "express";
import mongoose from "mongoose";
import FormStyle, { MAX_STYLES_PER_SCOPE } from "../models/FormStyle";
import Membership from "../models/Membership";
import Workspace from "../models/Workspace";
import { hasPermission } from "../middleware/permission.middleware";
import { normaliseLayout } from "../utils/layout";
import { createFormStyleSchema, renameFormStyleSchema } from "../validations/formStyle.validator";

// "Save my style": GET / POST /api/form-styles, PATCH (rename) and DELETE /api/form-styles/:id.
// Scope: a workspace's styles are visible to its members; in the personal space (no workspace) a style is its creator's alone.

const present = (s: any) => ({
  _id: String(s._id),
  id: String(s._id),
  name: s.name,
  layout: s.layout,
  branding: s.branding ?? {},
  createdBy: String(s.createdBy),
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

/** The query that selects the caller's own scope: the workspace they are in, or their personal space. */
const scopeOf = (req: Request) => {
  const authReq = req as any;
  const personal = authReq.explicitPersonalContext === true || !authReq.workspaceId;
  return personal ? { workspaceId: null, createdBy: authReq.user._id } : { workspaceId: new mongoose.Types.ObjectId(String(authReq.workspaceId)) };
};

const badRequest = (res: Response, message: string, errors?: unknown) => res.status(400).json({ success: false, message, ...(errors ? { errors } : {}) });

export const listFormStyles = async (req: Request, res: Response): Promise<void> => {
  try {
    const styles = await FormStyle.find(scopeOf(req)).sort({ createdAt: -1 }).limit(MAX_STYLES_PER_SCOPE);
    res.status(200).json({ success: true, data: styles.map(present), limit: MAX_STYLES_PER_SCOPE });
  } catch (error) {
    console.error("Error listing form styles:", error);
    res.status(500).json({ success: false, message: "Error listing styles" });
  }
};

export const createFormStyle = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = createFormStyleSchema.safeParse(req.body);
    if (!parsed.success) {
      return void badRequest(res, "Invalid style", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    const scope = scopeOf(req);
    if ((await FormStyle.countDocuments(scope)) >= MAX_STYLES_PER_SCOPE) {
      res.status(409).json({ success: false, message: `You can keep up to ${MAX_STYLES_PER_SCOPE} saved styles. Delete one to save another.`, error: { code: "STYLE_LIMIT" } });
      return;
    }
    // A style is a look, not a form's own content: a photographer's credit belongs to a photo (and a style never keeps an outside photo), and the
    // button text and the note under the form are that one form's words. None of them travel in a style.
    const branding: Record<string, any> = { ...parsed.data.branding };
    if (branding.theme) {
      const { credit: _credit, labels: _labels, footer: _footer, crop: _crop, success, ...theme } = branding.theme;
      // of the thank-you screen a style keeps the look (the accent colour and the confetti), not the form's own headline, picture or redirect
      const look = { ...(success?.colour ? { colour: success.colour } : {}), ...(success?.confetti !== undefined ? { confetti: success.confetti } : {}) };
      if (Object.keys(look).length) (theme as Record<string, unknown>).success = look;
      if (Object.keys(theme).length > 1) branding.theme = theme;
      else delete branding.theme;
    }
    const authReq = req as any;
    const created = await FormStyle.create({
      ...scope,
      createdBy: authReq.user._id,
      name: parsed.data.name,
      layout: normaliseLayout(parsed.data.layout),
      branding,
    });
    res.status(201).json({ success: true, data: present(created) });
  } catch (error) {
    console.error("Error creating form style:", error);
    res.status(500).json({ success: false, message: "Error saving the style" });
  }
};

/** Finds one style in the caller's own scope (so another workspace's id is a plain 404), and says whether the caller may change it. */
const findOwn = async (req: Request) => {
  const id = req.params.id;
  if (!id || typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) return null;
  const authReq = req as any;
  const style = await FormStyle.findOne({ _id: id, ...scopeOf(req) });
  if (!style) return null;
  let mayChange = String(style.createdBy) === String(authReq.user._id);
  if (!mayChange && style.workspaceId) {
    // an Owner or Admin of the workspace may tidy up anyone's style
    const membership = await Membership.findOne({ userId: authReq.user._id, workspaceId: style.workspaceId });
    const owner = await Workspace.exists({ _id: style.workspaceId, owner: authReq.user._id });
    const role = membership?.role || (owner ? "owner" : null);
    mayChange = !!role && hasPermission(role, "templates:create");
  }
  return { style, mayChange };
};

export const renameFormStyle = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = renameFormStyleSchema.safeParse(req.body);
    if (!parsed.success) return void badRequest(res, "Invalid name", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const found = await findOwn(req);
    if (!found) return void res.status(404).json({ success: false, message: "Style not found" });
    if (!found.mayChange) return void res.status(403).json({ success: false, message: "Only the person who saved a style, or an Owner or Admin, can change it" });
    found.style.name = parsed.data.name;
    await found.style.save();
    res.status(200).json({ success: true, data: present(found.style) });
  } catch (error) {
    console.error("Error renaming form style:", error);
    res.status(500).json({ success: false, message: "Error renaming the style" });
  }
};

export const removeFormStyle = async (req: Request, res: Response): Promise<void> => {
  try {
    const found = await findOwn(req);
    if (!found) return void res.status(404).json({ success: false, message: "Style not found" });
    if (!found.mayChange) return void res.status(403).json({ success: false, message: "Only the person who saved a style, or an Owner or Admin, can remove it" });
    await FormStyle.deleteOne({ _id: found.style._id });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error removing form style:", error);
    res.status(500).json({ success: false, message: "Error removing the style" });
  }
};
