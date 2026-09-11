import { Request, Response, NextFunction } from "express";
import FormAccessGrant from "../models/FormAccessGrant";
import Form from "../models/Form";
import Workspace from "../models/Workspace";

export const getSharedWithMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" },
      });
      return;
    }

    const userId = authReq.user._id;

    // BE 0.7: Scoped to caller's own account only; never reveals other grantees
    const grants = await FormAccessGrant.find({ userId })
      .sort({ createdAt: -1 })
      .lean();

    if (grants.length === 0) {
      res.status(200).json({
        success: true,
        forms: [],
        total: 0,
        data: [],
      });
      return;
    }

    const formIds = grants.map((g) => g.formId);
    const forms = await Form.find({ _id: { $in: formIds } }).lean();
    const formMap = new Map<string, any>();
    for (const f of forms) {
      formMap.set(f._id.toString(), f);
    }

    // Collect workspace names if any
    const workspaceIds = forms
      .map((f) => f.workspaceId)
      .filter((wId) => !!wId);
    const workspaces = await Workspace.find({ _id: { $in: workspaceIds } })
      .select("name")
      .lean();
    const wsMap = new Map<string, string>();
    for (const ws of workspaces) {
      wsMap.set(ws._id.toString(), ws.name);
    }

    const result = grants
      .map((g) => {
        const form = formMap.get(g.formId.toString());
        if (!form) return null;

        const wsName = form.workspaceId ? wsMap.get(form.workspaceId.toString()) || null : null;

        return {
          id: form._id.toString(),
          _id: form._id,
          formId: form._id.toString(),
          title: form.title,
          description: form.description || "",
          status: form.status,
          role: g.role,
          accessLevel: g.role === "editor" ? "write" : "read",
          permission: g.role === "editor" ? "write" : "read",
          sharedBy: form.createdBy ? form.createdBy.toString() : null,
          responseCount: form.responseCount || 0,
          workspaceId: form.workspaceId ? form.workspaceId.toString() : null,
          workspaceName: wsName,
          sharedAt: g.createdAt,
          createdAt: form.createdAt,
          updatedAt: form.updatedAt,
        };
      })
      .filter(Boolean);

    res.status(200).json({
      success: true,
      forms: result,
      total: result.length,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
