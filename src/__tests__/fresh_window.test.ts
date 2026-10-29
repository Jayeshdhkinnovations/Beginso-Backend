import { startInFreshWindow } from "./helpers/freshWindow";

/**
 * The helper that keeps a burst of requests inside one rate-limit window. It must wait when a window is about to end, and must not wait (the
 * suite must not slow down) when there is plenty of time left.
 */
describe("startInFreshWindow", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const at = (msIntoMinute: number) => jest.setSystemTime(new Date(Math.floor(Date.UTC(2026, 9, 29, 12, 0, 0) / 60_000) * 60_000 + msIntoMinute));

  it("does not wait when there is plenty of the minute left", async () => {
    at(5_000); // 55 s left
    let done = false;
    const p = startInFreshWindow([60_000]).then(() => { done = true; });
    await Promise.resolve();
    await p;
    expect(done).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("waits for the next window when less than 10 s of this one are left, and then stops waiting", async () => {
    at(55_000); // 5 s left
    let done = false;
    const p = startInFreshWindow([60_000]).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    jest.advanceTimersByTime(5_049);
    await Promise.resolve();
    expect(done).toBe(false); // 1 ms short of the boundary plus the 50 ms margin
    jest.advanceTimersByTime(1);
    await p;
    expect(done).toBe(true);
    expect(Date.now() % 60_000).toBeGreaterThanOrEqual(50); // the burst now starts inside the new window, 50 ms in
  });

  it("checks every window it is given (a minute and an hour): one wait covers both when they end together", async () => {
    // 12:59:58: the minute and the hour both end in 2 s, so a single wait of 2.05 s puts the start inside both new windows
    jest.setSystemTime(new Date(Date.UTC(2026, 9, 29, 12, 59, 58)));
    const p = startInFreshWindow([60_000, 3_600_000]);
    jest.advanceTimersByTime(2_050);
    await p;
    expect(Date.now() % 60_000).toBe(50);
  });
});
