import { Request } from "express";
import mongoose from "mongoose";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { WorkspaceRole } from "../types/workspace.types";

// Sprint 14. The "active context" a request is about: one workspace the caller belongs to, or their personal
// space. Used by search and notifications, which (unlike most routes) are not tied to a resource id.
//
// The caller never gets a context they are not a member of: a header naming someone else's workspace is a 403,
// never a widened query. Absent / "personal" is the caller's own personal space.
export type RequestContext =
  | { kind: "personal" }
  | { kind: "workspace"; workspaceId: string; slug: string; name: string; role: WorkspaceRole };

export class ContextError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
  }
}

const PERSONAL = new Set(["", "personal", "null", "none", "personal-only"]);
const first = (v: unknown): string => String((Array.isArray(v) ? v[0] : v) ?? "").trim();

export const resolveRequestContext = async (req: Request): Promise<RequestContext> => {
  const userId = (req as any).user?._id;
  const slug = first(req.headers["x-workspace-slug"]).toLowerCase();
  const idHeader = first(req.headers["x-workspace-id"]);

  // An explicit "personal" slug wins over any workspace id header; no header at all is also personal.
  if (slug && PERSONAL.has(slug)) return { kind: "personal" };
  if (!slug && (!idHeader || PERSONAL.has(idHeader.toLowerCase()))) return { kind: "personal" };

  const ws = slug
    ? await Workspace.findOne({ slug }).select("_id name slug owner status").lean()
    : mongoose.Types.ObjectId.isValid(idHeader)
      ? await Workspace.findById(idHeader).select("_id name slug owner status").lean()
      : null;
  // Unknown and not-a-member are the same answer, so a slug cannot be probed for existence.
  const forbidden = () => new ContextError(403, "Forbidden: Cross-workspace access denied", "FORBIDDEN_WORKSPACE_ACCESS");
  if (!ws || ws.status === "deleted") throw forbidden();

  const membership = await Membership.findOne({ userId, workspaceId: ws._id }).select("role").lean();
  const role: WorkspaceRole | null = membership?.role ?? (String(ws.owner) === String(userId) ? "owner" : null);
  if (!role) throw forbidden();
  return { kind: "workspace", workspaceId: String(ws._id), slug: ws.slug, name: ws.name, role };
};

// Express handler helper: resolves the context or writes the error response and returns null.
export const contextOrRespond = async (req: Request, res: any): Promise<RequestContext | null> => {
  try {
    return await resolveRequestContext(req);
  } catch (err) {
    if (err instanceof ContextError) {
      res.status(err.status).json({ success: false, message: err.message, error: { code: err.code, message: err.message } });
      return null;
    }
    throw err;
  }
};
