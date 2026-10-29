// Everything the server starts on its own, with no user request behind it. Kept in one place so it can be switched off as a whole:
//
//   BACKGROUND_JOBS=off      (also false, 0, no)   default: on, so nothing changes for a server that does not set it
//
// Why a switch exists: when a SECOND process is started against the same database (a test container beside the live server, a
// restored copy, a rehearsal of a cutover), only one process should be running these. Two of them double the work, and the one with a
// different uploads folder would write report files and delete files the other one needs.
//
// What each job writes (so the choice is an informed one):
//   - closeExpiredForms        Form.status "published" -> "closed" for forms past their close date. Database only.
//   - purgeExpiredTrash        PERMANENTLY deletes forms and responses that sat in Trash for 30 days: their database records AND their
//                              files from the uploads folder of THIS process. At most 50 forms and 50 responses per run.
//   - reconcileAllStorage      sets User.storageUsedBytes to the value recomputed from the database. It never reads the disk, never
//                              deletes a file and never creates, changes or deletes a record other than that one counter.
//   - recoverReportQueue       puts reports stuck in "processing" for 15 minutes back to "queued", then starts the queue, which GENERATES
//                              every queued report here (files written under this process's uploads folder).
//   - EmailVerification.syncIndexes   makes that one collection's indexes match this version's schema (can drop a stale index).
import { closeExpiredForms } from "./form.service";
import { recoverReportQueue } from "./reportQueue";
import { purgeExpiredTrash } from "./trash.service";
import { reconcileAllStorage } from "./storage.service";
import EmailVerification from "../models/EmailVerification";

const OFF_VALUES = ["off", "false", "0", "no"];

/** On unless the variable says off. An unset, empty or unrecognised value means on, exactly as before the switch existed. */
export const backgroundJobsEnabled = (value: string | undefined): boolean => !OFF_VALUES.includes(String(value ?? "").trim().toLowerCase());

export interface BackgroundJobDeps {
  closeExpiredForms: () => Promise<unknown>;
  purgeExpiredTrash: () => Promise<unknown>;
  reconcileAllStorage: () => Promise<Array<{ fixed: boolean; skipped?: boolean }>>;
  recoverReportQueue: () => Promise<unknown>;
  syncEmailVerificationIndexes: () => Promise<unknown>;
  log: (message: string) => void;
  error: (message: string, error: unknown) => void;
}

const productionDeps: BackgroundJobDeps = {
  closeExpiredForms,
  purgeExpiredTrash: () => purgeExpiredTrash(),
  reconcileAllStorage: () => reconcileAllStorage(),
  recoverReportQueue: () => recoverReportQueue(),
  // The email-verification collection changed shape once (a link became a code), and Mongoose never drops an index the schema no
  // longer has: a leftover UNIQUE index on the old field made every request after the first fail with a duplicate-key error (11000).
  // syncIndexes() makes this one collection's indexes match the schema again. It touches only this collection and is idempotent.
  syncEmailVerificationIndexes: () => EmailVerification.syncIndexes(),
  log: (message) => console.log(message),
  error: (message, error) => console.error(message, error),
};

const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * Starts the jobs unless BACKGROUND_JOBS is off. Returns whether they were started. The intervals are unref'd, so they never keep the
 * process alive.
 */
export const startBackgroundJobs = (env: NodeJS.ProcessEnv = process.env, deps: BackgroundJobDeps = productionDeps): boolean => {
  if (!backgroundJobsEnabled(env.BACKGROUND_JOBS)) {
    deps.log("Background jobs are OFF (BACKGROUND_JOBS): no sweep, no Trash purge, no storage reconcile, no report-queue recovery, no index sync.");
    return false;
  }

  deps.log("Background jobs are ON: sweep and Trash purge every 5 minutes, storage reconcile daily, report queue recovered at start.");
  deps.syncEmailVerificationIndexes().catch((e) => deps.error("EmailVerification.syncIndexes failed:", e));

  // Close forms whose close date has passed: once now, then every 5 minutes.
  const sweep = () => deps.closeExpiredForms().catch((e) => deps.error("closeExpiredForms failed:", e));
  sweep();
  deps.recoverReportQueue().catch((e) => deps.error("recoverReportQueue failed:", e));
  setInterval(sweep, FIVE_MINUTES).unref();

  // Sprint 13 (CF5.5): permanently remove anything that has sat in Trash for 30 days. Same cadence as the sweep above; bounded per run
  // and idempotent, so it is safe on several instances at once.
  const retention = () => deps.purgeExpiredTrash().catch((e) => deps.error("purgeExpiredTrash failed:", e));
  retention();
  setInterval(retention, FIVE_MINUTES).unref();

  // B-14: byte-level drift in the per-user storage counter is corrected once a day (first run 10 minutes after start, so a restart does
  // not add load). Every mismatch is logged by reconcileUser. 0 hours turns it off.
  const reconcileHours = Number(env.STORAGE_RECONCILE_INTERVAL_HOURS ?? 24);
  if (reconcileHours > 0) {
    const reconcile = () =>
      deps
        .reconcileAllStorage()
        .then((rs) => deps.log(`[storage] reconcile: ${rs.length} checked, ${rs.filter((r) => r.fixed).length} corrected, ${rs.filter((r) => r.skipped).length} skipped`))
        .catch((e) => deps.error("reconcileAllStorage failed:", e));
    setTimeout(() => {
      reconcile();
      setInterval(reconcile, reconcileHours * 60 * 60 * 1000).unref();
    }, 10 * 60 * 1000).unref();
  }
  return true;
};
