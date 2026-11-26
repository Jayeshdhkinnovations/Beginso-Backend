import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { metricsQuerySchema } from "../validations/adminMetrics.validator";
import * as metrics from "../services/adminMetrics.service";

// Thin HTTP layer for the super admin metrics (see the comments in this file). Read-only; the router already applies protect and
// requireSuperAdmin. Answers are never cached by the browser or a proxy: the server keeps its own 60 second cache.

const respond =
  (run: (q: ReturnType<typeof metricsQuerySchema.parse>) => Promise<{ data: unknown; meta: unknown }>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = metricsQuerySchema.parse(req.query);
      const { data, meta } = await run(query);
      res.set("Cache-Control", "no-store").json({ success: true, data, meta });
    } catch (error: any) {
      if (error instanceof ZodError) {
        res.status(422).json({ success: false, message: "Invalid query", errors: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      } else if (error?.statusCode === 422) {
        res.status(422).json({ success: false, message: error.message });
      } else {
        next(error);
      }
    }
  };

export const getOverviewMetrics = respond((q) => metrics.getOverviewMetrics(q));
export const getGrowthMetrics = respond((q) => metrics.getGrowthMetrics(q));
export const getEngagementMetrics = respond((q) => metrics.getEngagementMetrics(q));
export const getUsageMetrics = respond((q) => metrics.getUsageMetrics(q));
export const getAttentionMetrics = respond((q) => metrics.getAttentionMetrics(q));
