import { backgroundJobsEnabled, startBackgroundJobs, BackgroundJobDeps } from "../services/backgroundJobs";

/**
 * The server starts four things on its own (sweep of expired forms, Trash purge, daily storage reconcile, report-queue recovery) plus one
 * index sync. BACKGROUND_JOBS=off turns all of them off, so a second process (a test container, a rehearsal) never runs them beside the
 * live one. Default is ON: a server that does not set the variable behaves exactly as before.
 */
const deps = (): jest.Mocked<BackgroundJobDeps> => ({
  closeExpiredForms: jest.fn().mockResolvedValue(0),
  purgeExpiredTrash: jest.fn().mockResolvedValue({ forms: 0, responses: 0 }),
  reconcileAllStorage: jest.fn().mockResolvedValue([{ fixed: false }]),
  recoverReportQueue: jest.fn().mockResolvedValue(undefined),
  syncEmailVerificationIndexes: jest.fn().mockResolvedValue(undefined),
  log: jest.fn(),
  error: jest.fn(),
});

describe("backgroundJobsEnabled", () => {
  it.each([undefined, "", "on", "true", "1", "yes", "anything-else", "  ON  "])("%j means on (the default is unchanged)", (value) => {
    expect(backgroundJobsEnabled(value)).toBe(true);
  });
  it.each(["off", "OFF", " Off ", "false", "0", "no"])("%j means off", (value) => {
    expect(backgroundJobsEnabled(value)).toBe(false);
  });
});

describe("startBackgroundJobs", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("OFF: nothing runs now, nothing is scheduled, and the log says so", () => {
    const d = deps();
    expect(startBackgroundJobs({ BACKGROUND_JOBS: "off" }, d)).toBe(false);
    jest.advanceTimersByTime(48 * 60 * 60 * 1000); // two days
    for (const job of [d.closeExpiredForms, d.purgeExpiredTrash, d.reconcileAllStorage, d.recoverReportQueue, d.syncEmailVerificationIndexes]) {
      expect(job).not.toHaveBeenCalled();
    }
    expect(jest.getTimerCount()).toBe(0);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("OFF"));
  });

  it("ON by default (variable not set): runs at start, repeats every 5 minutes, and reconciles once after 10 minutes", async () => {
    const d = deps();
    expect(startBackgroundJobs({}, d)).toBe(true);
    expect(d.syncEmailVerificationIndexes).toHaveBeenCalledTimes(1);
    expect(d.recoverReportQueue).toHaveBeenCalledTimes(1);
    expect(d.closeExpiredForms).toHaveBeenCalledTimes(1);
    expect(d.purgeExpiredTrash).toHaveBeenCalledTimes(1);
    expect(d.reconcileAllStorage).not.toHaveBeenCalled(); // not at start: a restart adds no load

    jest.advanceTimersByTime(5 * 60 * 1000);
    expect(d.closeExpiredForms).toHaveBeenCalledTimes(2);
    expect(d.purgeExpiredTrash).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(5 * 60 * 1000); // 10 minutes in
    expect(d.reconcileAllStorage).toHaveBeenCalledTimes(1);
    expect(d.recoverReportQueue).toHaveBeenCalledTimes(1); // only at start
  });

  it("STORAGE_RECONCILE_INTERVAL_HOURS=0 still turns the daily reconcile off on its own", () => {
    const d = deps();
    startBackgroundJobs({ STORAGE_RECONCILE_INTERVAL_HOURS: "0" }, d);
    jest.advanceTimersByTime(48 * 60 * 60 * 1000);
    expect(d.reconcileAllStorage).not.toHaveBeenCalled();
    expect(d.closeExpiredForms).toHaveBeenCalled();
  });

  it("a job that fails is logged and does not stop the others", async () => {
    const d = deps();
    d.closeExpiredForms.mockRejectedValue(new Error("db down"));
    startBackgroundJobs({}, d);
    await Promise.resolve();
    await Promise.resolve();
    expect(d.error).toHaveBeenCalledWith("closeExpiredForms failed:", expect.any(Error));
    expect(d.purgeExpiredTrash).toHaveBeenCalled();
  });
});
