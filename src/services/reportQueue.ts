import ReportModel from "../models/Report";
import { generateReportAsync } from "./report.service";

// Report files are generated inside the API process, so how many run at once is capped: extra
// jobs wait as `queued` in MongoDB and are picked up oldest first as slots free up. Because the
// queue is the collection itself, a restart loses nothing: recoverReportQueue() puts jobs that
// were mid-run back in line.
// ponytail: still runs in this process. Move generation to a separate worker once one report
// regularly takes long enough to hurt request latency.
const concurrency = (): number => {
  const n = parseInt(process.env.REPORT_CONCURRENCY ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
};

let running = 0;
let draining = false;

const drain = async (): Promise<void> => {
  if (draining) return;
  draining = true;
  try {
    while (running < concurrency()) {
      // Claim atomically so two ticks (or two processes) never run the same job.
      const next = await ReportModel.findOneAndUpdate(
        { status: "queued" },
        { $set: { status: "processing" } },
        { sort: { createdAt: 1 }, new: true }
      );
      if (!next) break;
      running += 1;
      generateReportAsync(String(next._id))
        .catch((err) => console.error("Background report generation error:", err))
        .finally(() => {
          running -= 1;
          void drain();
        });
    }
  } catch (err) {
    console.error("Report queue error:", err);
  } finally {
    draining = false;
  }
};

export const kickReportQueue = (): void => {
  setImmediate(() => void drain());
};

// Jobs left `processing` by a crash or restart go back to the queue (older than `staleMs`).
export const recoverReportQueue = async (staleMs = 15 * 60 * 1000): Promise<void> => {
  await ReportModel.updateMany(
    { status: "processing", updatedAt: { $lt: new Date(Date.now() - staleMs) } },
    { $set: { status: "queued" } }
  );
  kickReportQueue();
};
