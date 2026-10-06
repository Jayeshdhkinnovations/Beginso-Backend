import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Membership from "../models/Membership";
import Template from "../models/Template";
import User from "../models/User";
import FormAccessGrant from "../models/FormAccessGrant";
import { contextOrRespond, RequestContext } from "../utils/contextScope";
import { hasPermission } from "../middleware/permission.middleware";
import { WorkspaceRole } from "../types/workspace.types";

// Sprint 14 (B2.1-B2.4, F14, C3.7). GET /api/search - one context, permission-filtered BEFORE anything is
// counted or returned, so a total can never disclose more than the items beneath it.
//
// What it searches (P4: answers are not indexed, so answer text is never searched or returned):
//   forms      title
//   responses  reference + respondent email / name ONLY
//   members    name + email
//   templates  name + category
// What it never returns: answers, notes, attachment names, raw IPs.
//
// Visibility, computed fresh on every request (so a revoked grant or removed member loses results at once):
//   workspace context  the caller must be a member (403 otherwise); every role may read forms/responses/members/
//                      templates, checked against ROLE_PERMISSIONS rather than assumed; archived and trashed forms
//                      and trashed / test responses are excluded.
//   personal context   the caller's own personal forms, forms shared with them by a per-form grant (the grant's
//                      role must allow the read), and the responses they submitted themselves.

type GroupKey = "forms" | "responses" | "members" | "templates";
const GROUPS: GroupKey[] = ["forms", "responses", "members", "templates"];

interface Group {
  total: number;
  items: any[];
}
const emptyGroup = (): Group => ({ total: 0, items: [] });

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const bad = (res: Response, message: string): void => {
  res.status(400).json({ success: false, message, error: { code: "VALIDATION_ERROR", message } });
};

interface Visible {
  formIds: mongoose.Types.ObjectId[];
  // forms whose responses the caller may read (grant roles are checked individually)
  responseFormIds: mongoose.Types.ObjectId[];
  canListMembers: boolean;
  canReadTemplates: boolean;
}

const visibleScope = async (userId: any, ctx: RequestContext): Promise<Visible> => {
  if (ctx.kind === "workspace") {
    const role: WorkspaceRole = ctx.role;
    const canForms = hasPermission(role, "forms:read");
    const forms = canForms ? await Form.find({ workspaceId: ctx.workspaceId, archivedAt: null }).select("_id").lean() : [];
    const formIds = forms.map((f) => f._id as mongoose.Types.ObjectId);
    return {
      formIds,
      responseFormIds: hasPermission(role, "responses:read") ? formIds : [],
      canListMembers: hasPermission(role, "workspace:read"),
      canReadTemplates: hasPermission(role, "templates:read"),
    };
  }

  const [own, grants] = await Promise.all([
    Form.find({ workspaceId: null, createdBy: userId, archivedAt: null }).select("_id").lean(),
    FormAccessGrant.find({ userId }).select("formId role").lean(),
  ]);
  const grantedForms = grants.length
    ? await Form.find({ _id: { $in: grants.map((g) => g.formId) }, archivedAt: null }).select("_id").lean()
    : [];
  const liveGranted = new Set(grantedForms.map((f) => String(f._id)));
  const roleByForm = new Map(grants.map((g) => [String(g.formId), g.role as WorkspaceRole]));
  const grantReadable = (permission: string) =>
    [...liveGranted].filter((id) => hasPermission(roleByForm.get(id)!, permission)).map((id) => new mongoose.Types.ObjectId(id));

  const ownIds = own.map((f) => f._id as mongoose.Types.ObjectId);
  return {
    formIds: [...ownIds, ...grantReadable("forms:read")],
    responseFormIds: [...ownIds, ...grantReadable("responses:read")],
    canListMembers: false,
    canReadTemplates: true,
  };
};

export const search = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) return bad(res, "q must be at least 2 characters");
    if (q.length > 100) return bad(res, "q must be at most 100 characters");

    let types = GROUPS;
    if (req.query.types !== undefined) {
      const asked = String(req.query.types).split(",").map((t) => t.trim()).filter(Boolean);
      if (asked.length === 0 || asked.some((t) => !GROUPS.includes(t as GroupKey))) return bad(res, "Invalid types filter");
      types = asked as GroupKey[];
    }

    const rawLimit = req.query.limit === undefined ? 5 : parseInt(String(req.query.limit), 10);
    if (!Number.isFinite(rawLimit) || rawLimit < 1) return bad(res, "limit must be a positive number");
    const limit = Math.min(10, rawLimit);

    const ctx = await contextOrRespond(req, res);
    if (!ctx) return;
    const userId = authReq.user._id;

    const rx = new RegExp(escapeRegex(q), "i");
    const scope = await visibleScope(userId, ctx);
    const groups: Record<GroupKey, Group> = { forms: emptyGroup(), responses: emptyGroup(), members: emptyGroup(), templates: emptyGroup() };

    // Titles for the forms named on response rows.
    const formTitleCache = new Map<string, string>();

    const jobs: Promise<void>[] = [];

    if (types.includes("forms") && scope.formIds.length) {
      jobs.push(
        (async () => {
          const filter = { _id: { $in: scope.formIds }, archivedAt: null, title: rx };
          const [total, items] = await Promise.all([
            Form.countDocuments(filter),
            Form.find(filter).sort({ updatedAt: -1 }).limit(limit).select("title status archivedAt").lean(),
          ]);
          groups.forms = {
            total,
            items: items.map((f: any) => ({
              id: String(f._id),
              type: "forms",
              title: f.title,
              subtitle: f.status,
              status: f.status,
              archived: !!f.archivedAt,
            })),
          };
        })()
      );
    }

    if (types.includes("responses")) {
      jobs.push(
        (async () => {
          // Respondent name: only a signed-in respondent has one (their account name). Anonymous answers are never read.
          const matchedUsers = await User.find({ $or: [{ fullName: rx }, { email: rx }] }).select("_id").limit(100).lean();
          const byRespondent = [{ reference: rx }, { respondentEmail: rx }, ...(matchedUsers.length ? [{ respondentUserId: { $in: matchedUsers.map((u) => u._id) } }] : [])];

          const clauses: any[] = [];
          if (scope.responseFormIds.length) clauses.push({ formId: { $in: scope.responseFormIds }, $or: byRespondent });
          // Personal context also covers the caller's own submissions (My Submissions): only rows they submitted,
          // on forms that still exist (the Form hook drops trashed ones), matched by reference alone.
          if (ctx.kind === "personal") {
            const submittedTo = await ResponseModel.distinct("formId", { respondentUserId: userId, deletedAt: null });
            const live = submittedTo.length ? await Form.find({ _id: { $in: submittedTo } }).select("_id").lean() : [];
            if (live.length) clauses.push({ formId: { $in: live.map((f) => f._id) }, respondentUserId: userId, reference: rx });
          }
          if (!clauses.length) return;

          const filter: any = { deletedAt: null, $or: clauses }; // the Response hook drops isTest
          const [total, rows] = await Promise.all([
            ResponseModel.countDocuments(filter),
            ResponseModel.find(filter).sort({ submittedAt: -1 }).limit(limit).select("formId reference submittedAt respondentEmail createdAt").lean(),
          ]);
          const forms = await Form.find({ _id: { $in: [...new Set(rows.map((r: any) => String(r.formId)))] } }).select("title").lean();
          for (const f of forms) formTitleCache.set(String(f._id), (f as any).title);

          groups.responses = {
            total,
            items: rows.map((r: any) => ({
              id: String(r._id),
              type: "responses",
              title: r.reference || "Response",
              subtitle: r.respondentEmail || undefined,
              formId: String(r.formId),
              formTitle: formTitleCache.get(String(r.formId)) ?? "",
              reference: r.reference || "",
              submittedAt: new Date(r.submittedAt || r.createdAt).toISOString(),
            })),
          };
        })()
      );
    }

    if (types.includes("members") && ctx.kind === "workspace" && scope.canListMembers) {
      jobs.push(
        (async () => {
          const memberships = await Membership.find({ workspaceId: ctx.workspaceId }).select("userId role").lean();
          const roleByUser = new Map(memberships.map((m) => [String(m.userId), m.role]));
          const userFilter = { _id: { $in: memberships.map((m) => m.userId) }, $or: [{ fullName: rx }, { email: rx }] };
          const [total, users] = await Promise.all([
            User.countDocuments(userFilter),
            User.find(userFilter).sort({ fullName: 1 }).limit(limit).select("fullName email").lean(),
          ]);
          groups.members = {
            total,
            items: users.map((u: any) => ({
              id: String(u._id),
              type: "members",
              title: u.fullName,
              subtitle: u.email,
              role: roleByUser.get(String(u._id)) || "member",
            })),
          };
        })()
      );
    }

    if (types.includes("templates") && scope.canReadTemplates) {
      jobs.push(
        (async () => {
          const owner =
            ctx.kind === "workspace"
              ? { $or: [{ workspaceId: null }, { workspaceId: ctx.workspaceId }] }
              : { workspaceId: null };
          const filter: any = { isActive: true, $and: [owner, { $or: [{ name: rx }, { category: rx }] }] };
          const [total, items] = await Promise.all([
            Template.countDocuments(filter),
            Template.find(filter).sort({ name: 1 }).limit(limit).select("name category workspaceId").lean(),
          ]);
          groups.templates = {
            total,
            items: items.map((t: any) => ({
              id: String(t._id),
              type: "templates",
              title: t.name,
              subtitle: t.category,
              source: t.workspaceId ? "workspace" : "beginso",
              category: t.category,
            })),
          };
        })()
      );
    }

    await Promise.all(jobs);

    res.status(200).json({
      success: true,
      q,
      scope: ctx.kind === "workspace" ? { kind: "workspace", label: ctx.name } : { kind: "personal", label: "Personal" },
      answerSearch: false,
      groups,
    });
  } catch (error) {
    next(error);
  }
};
