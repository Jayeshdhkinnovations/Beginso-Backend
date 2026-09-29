import mongoose from "mongoose";
import Membership from "../models/Membership";
import FormAccessGrant from "../models/FormAccessGrant";

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
