import { Request, Response, NextFunction } from "express";
import Form from "../models/Form";
import Workspace from "../models/Workspace";
import ResponseModel from "../models/Response";

export const getAnalytics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Not authorized" });
      return;
    }

    // 1. Get workspace associated with the user
    let workspaceId = authReq.user.workspaceId;
    if (workspaceId && typeof workspaceId === "object" && workspaceId._id) {
      workspaceId = workspaceId._id.toString();
    } else if (workspaceId) {
      workspaceId = workspaceId.toString();
    }

    if (!workspaceId) {
      const workspace = await Workspace.findOne({ owner: authReq.user._id });
      if (workspace) {
        workspaceId = workspace._id.toString();
      }
    }

    // 2. Find all forms in the workspace, or the caller's personal (workspaceId: null) forms
    // if they have no active workspace (C1.6 lazy-workspace model).
    const forms = workspaceId
      ? await Form.find({ workspaceId: workspaceId.toString() })
      : await Form.find({ workspaceId: null, createdBy: authReq.user._id });
    const formIds = forms.map((f) => f._id);
    const formMap = new Map(forms.map((f) => [f._id.toString(), f.title]));

    const totalForms = forms.length;
    const publishedForms = forms.filter((f) => f.status === "published").length;

    // Start of current month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // 3. Aggregate total responses & responses this month
    const totalResponses = await ResponseModel.countDocuments({ formId: { $in: formIds } });
    const responsesThisMonth = await ResponseModel.countDocuments({
      formId: { $in: formIds },
      submittedAt: { $gte: startOfMonth },
    });

    // 4. Fetch recent responses for recent activity (limit 5 per contract)
    const recentResponses = await ResponseModel.find({ formId: { $in: formIds } })
      .sort({ submittedAt: -1 })
      .limit(5);

    const recentActivity = recentResponses.map((r) => ({
      id: r._id.toString(),
      type: "response_submitted",
      occurredAt: (r.submittedAt || r.createdAt).toISOString(),
      form: {
        _id: r.formId.toString(),
        title: formMap.get(r.formId.toString()) || "Form Response",
      },
      responseId: r._id.toString(),
      // Backwards compatibility
      title: formMap.get(r.formId.toString()) || "Form Response",
      description: `New response received`,
      timestamp: r.submittedAt || r.createdAt,
    }));

    // 5. Aggregate per-form total and completed response counts using MongoDB $group pipeline
    const formStatsArr = await ResponseModel.aggregate([
      { $match: { formId: { $in: formIds } } },
      {
        $group: {
          _id: "$formId",
          total: { $sum: 1 },
          completed: {
            $sum: {
              $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
            },
          },
        },
      },
    ]);
    const formStatsMap = new Map(
      formStatsArr.map((item) => [
        item._id.toString(),
        { total: item.total, completed: item.completed },
      ])
    );

    const formsBreakdown = forms.map((form) => {
      const fId = form._id.toString();
      const stats = formStatsMap.get(fId) || { total: 0, completed: 0 };
      const responseRate =
        stats.total > 0 ? Number(((stats.completed / stats.total) * 100).toFixed(2)) : 0;
      return {
        formId: fId,
        title: form.title,
        status: form.status,
        responseCount: stats.total,
        responseRate,
        updatedAt: form.updatedAt,
      };
    });

    const analyticsData = {
      totalForms,
      publishedForms,
      totalResponses,
      responsesThisMonth,
      recentActivity,
      formsBreakdown,
    };

    res.status(200).json({
      success: true,
      analytics: analyticsData,
      data: analyticsData,
    });
  } catch (error) {
    next(error);
  }
};
