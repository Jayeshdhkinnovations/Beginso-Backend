import mongoose from "mongoose";
import Membership from "../models/Membership";
import FormAccessGrant from "../models/FormAccessGrant";
import { hasPermission } from "../middleware/permission.middleware";

// Shared by response.service.ts, bulk.service.ts and note.service.ts: "a current member with
// access to this form" is either a workspace membership of the form's own workspace, or a
// per-form access grant. Returns false uniformly for a nonexistent user and for a real user with
// no access — callers rely on that to keep a 422 from ever revealing which case it was.
export const userHasAccessToForm = async (
  userId: string,
  formId: string,
  workspaceId: string | null | undefined
): Promise<boolean> => {
  if (!mongoose.Types.ObjectId.isValid(userId)) return false;
  if (workspaceId) {
    const membership = await Membership.findOne({ userId, workspaceId }).lean();
    if (membership) return true;
  }
  const grant = await FormAccessGrant.findOne({ userId, formId }).lean();
  return !!grant;
};

/**
 * The forms a report may export. Workspace report: that workspace's forms. Personal report
 * (workspaceId null): the requester's own personal forms plus forms shared to them by a grant
 * whose role may export (reports:create), so a member/admin grantee can export what they were given.
 */
export const reportFormsFilter = async (workspaceId: any, userId: any): Promise<any> => {
  if (workspaceId) return { workspaceId };
  const grants = await FormAccessGrant.find({ userId }).select("formId role").lean();
  const sharedIds = grants.filter((g) => hasPermission(g.role, "reports:create")).map((g) => g.formId);
  return { $or: [{ workspaceId: null, createdBy: userId }, { _id: { $in: sharedIds } }] };
};
