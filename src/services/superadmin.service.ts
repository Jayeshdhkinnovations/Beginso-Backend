import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";
import { SystemLog } from "../models/SystemLog";
import { AuditLog } from "../models/AuditLog";
import { MailLog } from "../models/MailLog";
import { auth, revokeFirebaseUserTokens } from "../config/firebase";
import fs from "fs";
import path from "path";
import { getUploadDir, deleteFileAndEmptyParents } from "../controllers/upload.controller";

export class SuperAdminService {
  async getPlatformStats() {
    const activeAdmins = await User.countDocuments({ role: "admin", status: { $ne: "suspended" } });
    const suspendedAdmins = await User.countDocuments({ role: "admin", status: "suspended" });

    const totalWorkspaces = await Workspace.countDocuments();
    const totalForms = await Form.countDocuments();
    const publishedForms = await Form.countDocuments({ status: "published" });
    const totalResponses = await ResponseModel.countDocuments();

    // Cumulative storage used in bytes
    const storageUsedResult = await Upload.aggregate([
      { $group: { _id: null, total: { $sum: "$size" } } },
    ]);
    const totalStorageUsed = storageUsedResult[0]?.total || 0;

    // Submissions in last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const responsesLast24h = await ResponseModel.countDocuments({
      createdAt: { $gte: oneDayAgo },
    });

    // Errors in last 24 hours
    const errorCountLast24h = await SystemLog.countDocuments({
      level: "error",
      createdAt: { $gte: oneDayAgo },
    });

    const lastAdmins = await User.find({ role: "admin" })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("workspaceId");

    const recentSignups = lastAdmins.map((user: any) => ({
      name: user.fullName,
      email: user.email,
      workspaceName: user.workspaceId?.name || "No Workspace",
      createdAt: user.createdAt,
    }));

    const trends = await this.getHourlyTrends();

    return {
      stats: {
        totalAdmins: {
          active: activeAdmins,
          suspended: suspendedAdmins,
        },
        totalWorkspaces,
        totalForms,
        publishedForms,
        totalResponses,
        totalStorageUsed,
        responsesLast24h,
        errorCountLast24h,
      },
      recentSignups,
      trends,
    };
  }

  async getHourlyTrends() {
    const trends: any = {
      users: [],
      publishedForms: [],
      totalForms: [],
      totalResponses: [],
      storageUsed: [],
      responsesLast24h: [],
    };

    const now = new Date();
    const hours: Date[] = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 60 * 60 * 1000);
      d.setMinutes(0, 0, 0); // round to top of the hour
      hours.push(d);
    }

    const users = await User.find({ role: "admin" }, { createdAt: 1, status: 1 });
    const forms = await Form.find({}, { createdAt: 1, status: 1 });
    const responses = await ResponseModel.find({}, { createdAt: 1 });
    const uploads = await Upload.find({}, { size: 1, createdAt: 1 });

    for (const hour of hours) {
      const hourStr = hour.toISOString();

      const activeAtHour = users.filter(u => (u as any).createdAt <= hour && u.status !== "suspended").length;
      const suspendedAtHour = users.filter(u => (u as any).createdAt <= hour && u.status === "suspended").length;
      trends.users.push({ hour: hourStr, count: activeAtHour + suspendedAtHour });

      const pubFormsAtHour = forms.filter(f => (f as any).createdAt <= hour && f.status === "published").length;
      trends.publishedForms.push({ hour: hourStr, count: pubFormsAtHour });

      const totalFormsAtHour = forms.filter(f => (f as any).createdAt <= hour).length;
      trends.totalForms.push({ hour: hourStr, count: totalFormsAtHour });

      const totalResponsesAtHour = responses.filter(r => (r as any).createdAt <= hour).length;
      trends.totalResponses.push({ hour: hourStr, count: totalResponsesAtHour });

      const storageAtHour = uploads.filter(up => (up as any).createdAt <= hour).reduce((sum, up) => sum + up.size, 0);
      trends.storageUsed.push({ hour: hourStr, count: storageAtHour });

      const dayAgo = new Date(hour.getTime() - 24 * 60 * 60 * 1000);
      const respLast24h = responses.filter(r => (r as any).createdAt > dayAgo && (r as any).createdAt <= hour).length;
      trends.responsesLast24h.push({ hour: hourStr, count: respLast24h });
    }

    return trends;
  }

  async getAbuseStats() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Top 5 rate-limited IP hashes (first 16 chars)
    const topBlockedIps = await SystemLog.aggregate([
      {
        $match: {
          createdAt: { $gte: sevenDaysAgo },
          "meta.type": "rate_limit",
        },
      },
      {
        $group: {
          _id: "$meta.ipHash",
          hits: { $sum: 1 },
        },
      },
      { $sort: { hits: -1 } },
      { $limit: 5 },
      {
        $project: {
          ipHash: { $substrCP: ["$_id", 0, 16] },
          hits: 1,
          _id: 0,
        },
      },
    ]);

    // Top 5 rate-limited slugs
    const topBlockedSlugs = await SystemLog.aggregate([
      {
        $match: {
          createdAt: { $gte: sevenDaysAgo },
          "meta.type": "rate_limit",
        },
      },
      {
        $group: {
          _id: "$meta.slug",
          hits: { $sum: 1 },
        },
      },
      { $sort: { hits: -1 } },
      { $limit: 5 },
      {
        $project: {
          slug: "$_id",
          hits: 1,
          _id: 0,
        },
      },
    ]);

    // Honeypot silent-drop count
    const honeypotDrops = await SystemLog.countDocuments({
      createdAt: { $gte: sevenDaysAgo },
      "meta.type": "honeypot_drop",
    });

    return {
      abuse: {
        topBlockedIps,
        topBlockedSlugs,
        honeypotDrops,
      },
    };
  }

  async getLogs(filters: {
    level?: string;
    from?: string;
    to?: string;
    route?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const query: any = {};

    if (filters.level) {
      query.level = filters.level;
    }

    if (filters.route) {
      query.route = { $regex: filters.route, $options: "i" };
    }

    if (filters.search) {
      query.message = { $regex: filters.search, $options: "i" };
    }

    if (filters.from || filters.to) {
      query.createdAt = {};
      if (filters.from) {
        query.createdAt.$gte = new Date(filters.from);
      }
      if (filters.to) {
        query.createdAt.$lte = new Date(filters.to);
      }
    }

    let page = filters.page || 1;
    let limit = filters.limit || 20;

    // Clamp limit to avoid unbounded queries
    if (limit > 100) limit = 100;
    if (limit < 1) limit = 20;
    if (page < 1) page = 1;

    const skip = (page - 1) * limit;

    const total = await SystemLog.countDocuments(query);
    const logs = await SystemLog.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const isProduction = process.env.NODE_ENV === "production";
    const sanitizedLogs = logs.map((log) => {
      const logObj = log.toObject();
      if (logObj.level !== "error") {
        delete logObj.meta;
      }
      if (isProduction) {
        delete logObj.stack;
      }
      return logObj;
    });

    const pages = Math.ceil(total / limit);

    return {
      logs: sanitizedLogs,
      pagination: {
        total,
        page,
        limit,
        pages,
      },
    };
  }

  async getMailLogs(filters: {
    template?: string;
    outcome?: string;
    from?: string;
    to?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const query: any = {};

    if (filters.template) {
      query.template = filters.template;
    }

    if (filters.outcome) {
      query.outcome = filters.outcome;
    }

    if (filters.search && filters.search.trim() !== "") {
      query.requestId = { $regex: filters.search.trim(), $options: "i" };
    }

    if (filters.from || filters.to) {
      query.createdAt = {};
      if (filters.from) {
        query.createdAt.$gte = new Date(filters.from);
      }
      if (filters.to) {
        query.createdAt.$lte = new Date(filters.to);
      }
    }

    let page = Number(filters.page) || 1;
    let limit = Number(filters.limit) || 50;

    if (limit > 100) limit = 100;
    if (limit < 1) limit = 50;
    if (page < 1) page = 1;

    const skip = (page - 1) * limit;

    const total = await MailLog.countDocuments(query);
    const logs = await MailLog.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const pages = Math.ceil(total / limit) || (total === 0 ? 0 : 1);

    return {
      mailLogs: logs,
      pagination: {
        total,
        page,
        limit,
        pages,
      },
    };
  }

  async getAdmins(filters: { page?: number; limit?: number; search?: string; status?: string }) {
    let page = filters.page || 1;
    let limit = filters.limit || 20;

    if (limit > 100) limit = 100;
    if (limit < 1) limit = 20;
    if (page < 1) page = 1;

    const skip = (page - 1) * limit;

    const query: any = { role: "admin" };
    if (filters.status) {
      query.status = filters.status;
    }
    if (filters.search) {
      query.$or = [
        { fullName: { $regex: filters.search, $options: "i" } },
        { email: { $regex: filters.search, $options: "i" } },
      ];
    }

    const total = await User.countDocuments(query);
    const admins = await User.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("workspaceId");

    const adminList = [];
    for (const admin of admins) {
      const ws = admin.workspaceId as any;
      let formCount = 0;
      let responseCount = 0;
      if (ws) {
        formCount = await Form.countDocuments({ workspaceId: ws._id });
        const formDocs = await Form.find({ workspaceId: ws._id }, { _id: 1 });
        const formIds = formDocs.map((f) => f._id);
        responseCount = await ResponseModel.countDocuments({ formId: { $in: formIds } });
      }
      const storageResult = await Upload.aggregate([
        { $match: { owner: admin._id } },
        { $group: { _id: null, total: { $sum: "$size" } } },
      ]);
      const storageUsed = storageResult[0]?.total || 0;

      adminList.push({
        id: admin._id.toString(),
        name: admin.fullName,
        email: admin.email,
        workspaceName: ws?.name || "No Workspace",
        formCount,
        responseCount,
        storageUsed,
        lastLogin: (admin as any).updatedAt || (admin as any).createdAt,
        status: admin.status || "active",
      });
    }

    const pages = Math.ceil(total / limit);

    return {
      admins: adminList,
      pagination: {
        total,
        page,
        limit,
        pages,
      },
    };
  }

  async getAdminDetail(id: string) {
    const admin = await User.findOne({ _id: id, role: "admin" }).populate("workspaceId");
    if (!admin) {
      throw new Error("Admin not found");
    }
    const ws = admin.workspaceId as any;
    let formCount = 0;
    let responseCount = 0;
    if (ws) {
      formCount = await Form.countDocuments({ workspaceId: ws._id });
      const formDocs = await Form.find({ workspaceId: ws._id }, { _id: 1 });
      const formIds = formDocs.map((f) => f._id);
      responseCount = await ResponseModel.countDocuments({ formId: { $in: formIds } });
    }
    const storageResult = await Upload.aggregate([
      { $match: { owner: admin._id } },
      { $group: { _id: null, total: { $sum: "$size" } } },
    ]);
    const storageUsed = storageResult[0]?.total || 0;

    return {
      profile: {
        id: admin._id.toString(),
        name: admin.fullName,
        email: admin.email,
        status: admin.status || "active",
        createdAt: (admin as any).createdAt,
      },
      workspace: ws
        ? {
            id: ws._id.toString(),
            name: ws.name,
          }
        : null,
      usage: {
        formCount,
        responseCount,
        storageUsed,
      },
      loginHistory: (admin as any).loginHistory?.length
        ? (admin as any).loginHistory.slice(-5).reverse().map((e: any) => ({
            timestamp: e.timestamp,
            ip: e.ip || "unknown",
            userAgent: e.userAgent || "unknown",
            location:
              e.location &&
              e.location.latitude != null &&
              e.location.longitude != null &&
              !isNaN(e.location.latitude) &&
              !isNaN(e.location.longitude)
                ? {
                    city: e.location.city ?? null,
                    region: e.location.region ?? null,
                    country: e.location.country ?? null,
                    latitude: e.location.latitude,
                    longitude: e.location.longitude,
                  }
                : null,
          }))
        : [
            {
              timestamp: (admin as any).lastLogin || (admin as any).updatedAt || (admin as any).createdAt,
              ip: "unknown",
              userAgent: "unknown",
              location: null,
            },
          ],
    };
  }

  async createAdmin(
    actor: { id: string; email: string; fullName: string },
    data: { name: string; email: string; workspaceName: string }
  ) {
    const existing = await User.findOne({ email: data.email.toLowerCase() });
    if (existing) {
      throw new Error("User with this email already exists");
    }

    let firebaseUid = `admin-uid-${Buffer.from(data.email).toString("hex").substring(0, 15)}`;
    try {
      const fbUser = await auth.createUser({
        email: data.email,
        displayName: data.name,
        password: "TempPassword123!",
      });
      firebaseUid = fbUser.uid;
    } catch (fbErr: any) {
      if (fbErr.code === "auth/email-already-exists") {
        const fbUser = await auth.getUserByEmail(data.email);
        firebaseUid = fbUser.uid;
      } else {
        console.warn("⚠️ Firebase Admin SDK error during admin creation:", fbErr.message);
      }
    }

    const newAdmin = await User.create({
      firebaseUid,
      fullName: data.name,
      email: data.email,
      role: "admin",
      status: "active",
    });

    const workspace = await Workspace.create({
      name: data.workspaceName,
      owner: newAdmin._id,
    });
    newAdmin.workspaceId = workspace._id as any;
    await newAdmin.save();

    await AuditLog.create({
      actorId: actor.id,
      actorEmail: actor.email,
      actorName: actor.fullName,
      action: "admin.create",
      targetId: newAdmin._id.toString(),
      targetType: "admin",
      after: {
        name: newAdmin.fullName,
        email: newAdmin.email,
        workspaceId: workspace._id.toString(),
        workspaceName: workspace.name,
      },
    });

    return {
      admin: {
        id: newAdmin._id.toString(),
        name: newAdmin.fullName,
        email: newAdmin.email,
        workspaceId: workspace._id.toString(),
      },
    };
  }

  async updateAdmin(
    actor: { id: string; email: string; fullName: string },
    id: string,
    data: { name?: string; workspaceName?: string; status?: "active" | "suspended" }
  ) {
    const admin = await User.findOne({ _id: id, role: "admin" }).populate("workspaceId");
    if (!admin) {
      throw new Error("Admin not found");
    }

    const before = {
      name: admin.fullName,
      workspaceName: (admin.workspaceId as any)?.name || "No Workspace",
      status: admin.status || "active",
    };

    let action: "admin.edit" | "admin.suspend" | "admin.reactivate" = "admin.edit";
    if (data.status && data.status !== admin.status) {
      action = data.status === "suspended" ? "admin.suspend" : "admin.reactivate";
    }

    if (data.name) {
      admin.fullName = data.name;
    }
    if (data.status) {
      admin.status = data.status;
      if (data.status === "suspended" && admin.firebaseUid) {
        await revokeFirebaseUserTokens(admin.firebaseUid);
      }
    }
    if (data.workspaceName && admin.workspaceId) {
      await Workspace.updateOne({ _id: admin.workspaceId }, { name: data.workspaceName });
    }

    await admin.save();

    const after = {
      name: admin.fullName,
      workspaceName: data.workspaceName || before.workspaceName,
      status: admin.status || "active",
    };

    await AuditLog.create({
      actorId: actor.id,
      actorEmail: actor.email,
      actorName: actor.fullName,
      action,
      targetId: admin._id.toString(),
      targetType: "admin",
      before,
      after,
    });

    return {
      admin: {
        id: admin._id.toString(),
        name: admin.fullName,
        email: admin.email,
        workspaceName: after.workspaceName,
        status: admin.status,
      },
    };
  }

  async deleteAdmin(
    actor: { id: string; email: string; fullName: string },
    id: string,
    confirmEmail: string
  ) {
    const admin = await User.findOne({ _id: id, role: "admin" }).populate("workspaceId");
    if (!admin) {
      const error: any = new Error("Admin not found");
      error.statusCode = 404;
      throw error;
    }

    if (confirmEmail !== admin.email) {
      const error: any = new Error("Confirmation email does not match admin's email exactly.");
      error.statusCode = 422;
      throw error;
    }

    const wsId = (admin.workspaceId as any)?._id || admin.workspaceId;

    // 1. Delete Firebase user + MongoDB user
    try {
      if (admin.firebaseUid) {
        await auth.deleteUser(admin.firebaseUid);
      }
    } catch (fbErr: any) {
      console.warn("⚠️ Firebase user deletion error:", fbErr.message);
    }
    await User.deleteOne({ _id: admin._id });
    const userDeleted = true;

    // 2. Find forms by workspace
    const forms = wsId ? await Form.find({ workspaceId: wsId }) : [];
    const formIds = forms.map((f) => f._id);

    // 3. Find file metadata by owner
    const uploads = await Upload.find({ owner: admin._id });

    // 4. Delete physical storage objects then their upload docs
    let filesSuccessCount = 0;
    let filesFailedCount = 0;
    const uploadDir = getUploadDir();

    for (const up of uploads) {
      if (up.path) {
        const fullPath = path.isAbsolute(up.path)
          ? up.path
          : path.join(uploadDir, up.path);
        try {
          if (fs.existsSync(fullPath)) {
            await deleteFileAndEmptyParents(fullPath, uploadDir);
          }
          filesSuccessCount++;
        } catch (err) {
          console.error(`Failed to delete physical file: ${fullPath}`, err);
          filesFailedCount++;
        }
      }
    }
    await Upload.deleteMany({ owner: admin._id });

    // 5. Delete responses
    const respResult = formIds.length > 0 ? await ResponseModel.deleteMany({ formId: { $in: formIds } }) : { deletedCount: 0 };
    const responsesDeleted = respResult.deletedCount || 0;

    // 6. Delete forms
    const formsResult = wsId ? await Form.deleteMany({ workspaceId: wsId }) : { deletedCount: 0 };
    const formsDeleted = formsResult.deletedCount || forms.length;

    // 7. Delete workspace
    let workspaceDeleted = false;
    if (wsId) {
      await Workspace.deleteOne({ _id: wsId });
      workspaceDeleted = true;
    }

    // 8. Write audit log: admin.delete
    await AuditLog.create({
      actorId: actor.id,
      actorEmail: actor.email,
      actorName: actor.fullName,
      action: "admin.delete",
      targetId: admin._id.toString(),
      targetType: "admin",
      before: {
        name: admin.fullName,
        email: admin.email,
        workspaceId: wsId ? wsId.toString() : null,
      },
    });

    return {
      cascadeResult: {
        userDeleted,
        workspaceDeleted,
        formsDeleted,
        responsesDeleted,
        filesCleared: {
          successCount: filesSuccessCount,
          failedCount: filesFailedCount,
        },
      },
      hasFailedDeletions: filesFailedCount > 0,
    };
  }

  async getAuditLogs(filters: {
    actor?: string;
    action?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }) {
    const query: any = {};

    if (filters.actor) {
      query.$or = [
        { actorEmail: { $regex: filters.actor, $options: "i" } },
        { actorName: { $regex: filters.actor, $options: "i" } },
      ];
    }

    if (filters.action) {
      query.action = filters.action;
    }

    if (filters.from || filters.to) {
      query.timestamp = {};
      if (filters.from) {
        query.timestamp.$gte = new Date(filters.from);
      }
      if (filters.to) {
        query.timestamp.$lte = new Date(filters.to);
      }
    }

    let page = filters.page || 1;
    let limit = filters.limit || 20;

    if (limit > 100) limit = 100;
    if (limit < 1) limit = 20;
    if (page < 1) page = 1;

    const skip = (page - 1) * limit;

    const total = await AuditLog.countDocuments(query);
    const logs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit);

    const pages = Math.ceil(total / limit);

    return {
      auditLogs: logs,
      pagination: {
        total,
        page,
        limit,
        pages,
      },
    };
  }
}

export const superAdminService = new SuperAdminService();
