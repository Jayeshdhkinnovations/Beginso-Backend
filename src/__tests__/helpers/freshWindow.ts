/**
 * Starts a test early in the rate limiter's current window.
 *
 * The limiter counts in FIXED windows (a minute, an hour: `Math.floor(Date.now() / windowMs)`), so a burst of requests that crosses a window
 * boundary starts a new count in the middle: the request that should have been refused (429) is let through. A test that sends a burst and
 * expects the 4th and 5th to be refused therefore failed one run in a few dozen, on whichever runner was slow enough, whenever the burst
 * happened to straddle a clock minute. Waiting for the next window when fewer than `safeMs` are left makes the burst land inside one window
 * every time; the wait is at most `safeMs`, and only on the rare start that was close to a boundary.
 */
export const startInFreshWindow = async (windowsMs: number[] = [60_000, 3_600_000], safeMs = 10_000): Promise<void> => {
  for (const windowMs of windowsMs) {
    const left = windowMs - (Date.now() % windowMs);
    if (left < safeMs) await new Promise((resolve) => setTimeout(resolve, left + 50));
  }
};
