import crypto from "crypto";
import ResponseModel from "../models/Response";
import Workspace from "../models/Workspace";
import { SegmentError } from "../utils/fieldSegments";
import { runChart, resolveTimezone, type ChartDef, type ChartResult } from "../utils/chartQuery";

// Charts run inside the API process, so they are fenced: a query is cut at 5 s (maxTimeMS), at most four run at once (a fifth gets a
// 429 and a retry hint), identical simultaneous requests share one run, and an answer is reused for 45 s unless the form's questions
// or its responses changed (the key holds the form's content version, the number of responses and the newest one).

let maxRunning = 4;
const TTL_MS = 45_000;
const MAX_CACHED = 500;

let running = 0;
const cache = new Map<string, { at: number; value: ChartResult }>();
const inflight = new Map<string, Promise<ChartResult>>();

/** Only for tests: lower or restore the number of charts allowed to run at once. */
export const setMaxRunningForTests = (n: number): void => {
  maxRunning = n;
};

/** Only for tests: forget everything. */
export const resetChartCache = (): void => {
  cache.clear();
  inflight.clear();
  running = 0;
};

const workspaceZone = async (form: any): Promise<string> => {
  if (!form.workspaceId) return "UTC";
  const ws = await Workspace.findById(form.workspaceId).select("timezone").lean();
  return resolveTimezone(ws?.timezone);
};

export const chartTimezone = workspaceZone;

const stamp = async (form: any): Promise<string> => {
  const [count, newest] = await Promise.all([
    ResponseModel.countDocuments({ formId: form._id, deletedAt: null }),
    ResponseModel.findOne({ formId: form._id }).sort({ _id: -1 }).select("_id").lean(),
  ]);
  return `${form.contentVersion ?? 0}:${count}:${newest?._id ?? ""}`;
};

export const queryChart = async (form: any, def: ChartDef): Promise<ChartResult> => {
  const tz = await workspaceZone(form);
  const { display: _display, ...queryPart } = def; // how a chart looks never changes what it counts
  void _display;
  const key = crypto.createHash("sha1").update(JSON.stringify({ f: String(form._id), q: queryPart, tz, s: await stamp(form) })).digest("hex");

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;

  if (running >= maxRunning) throw new SegmentError(429, "CHART_BUSY", "Charts are busy right now. Try again in a few seconds.");
  running += 1;
  const run = runChart(form, def, { tz, maxTimeMS: 5000 })
    .then((value) => {
      if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((err: any) => {
      if (err?.codeName === "MaxTimeMSExpired" || err?.code === 50) throw new SegmentError(503, "CHART_TOO_SLOW", "This chart took too long to calculate. Add a filter or try again.");
      throw err;
    })
    .finally(() => {
      running -= 1;
      inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
};
