import { Request, Response } from "express";
import { verifyRecentReauth, findSharedOwnedWorkspaces, deleteAccountData } from "../services/cleanup.service";
import { recordEvent } from "../services/event.service";
import { getAuth } from "firebase-admin/auth";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";

export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const { fullName, isActive } = req.body;
    
    const user = await User.findById(authReq.user._id);
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    if (fullName !== undefined) user.fullName = fullName;
    if (isActive !== undefined) user.isActive = isActive;

    await user.save();

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// Closes the caller's account. Behind both DELETE /api/users/profile and DELETE /api/workspaces/current
// (the app's "Delete workspace" button, whose confirmation says it deletes the account).
export const deleteAccountFlow = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as any;
    const user = authReq.user;
    if (!user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    const reauth = await verifyRecentReauth(user, req.body?.reauthToken);
    if (!reauth.ok) {
      res.status(401).json({ success: false, message: reauth.message, error: { code: reauth.code, message: reauth.message } });
      return;
    }

    const shared = await findSharedOwnedWorkspaces(user._id);
    if (shared.length) {
      const message = "You own workspaces that other people belong to. Transfer ownership or remove the members first.";
      res.status(409).json({ success: false, message, error: { code: "OWNS_SHARED_WORKSPACES", message }, workspaces: shared });
      return;
    }

    // Firebase first: if it fails nothing has been deleted yet, so the user can simply retry.
    try {
      await getAuth().deleteUser(user.firebaseUid);
    } catch (firebaseError: any) {
      if (firebaseError?.code !== "auth/user-not-found") {
        console.error("Firebase deleteUser failed, account left untouched:", firebaseError);
        res.status(502).json({ success: false, message: "Could not close the account right now. Please try again." });
        return;
      }
    }

    const owned = await Workspace.find({ owner: user._id }).select("_id name").lean();
    for (const ws of owned) {
      await recordEvent(req, ws._id, "workspace.delete", { id: ws._id, type: "workspace", label: ws.name }, { accountClosed: true });
    }

    await deleteAccountData(user);

    res.status(200).json({
      success: true,
      message: "Account, owned workspaces and all associated data deleted successfully.",
    });
  } catch (error: any) {
    console.error("Account deletion failed:", error);
    res.status(500).json({ success: false, message: "Failed to delete account" });
  }
};

export const deleteProfile = deleteAccountFlow;
