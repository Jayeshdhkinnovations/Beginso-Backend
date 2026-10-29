// connectWithRetry: a database that is unreachable for a moment at start-up is waited for, not given up on.
import { connectWithRetry } from "../config/database";

describe("connectWithRetry", () => {
  it("connects on the first try without waiting", async () => {
    const connect = jest.fn().mockResolvedValue(undefined);
    const onRetry = jest.fn();
    await connectWithRetry(connect, 5, 0, onRetry);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("tries again after a failure and stops as soon as it works", async () => {
    const connect = jest.fn().mockRejectedValueOnce(new Error("no primary")).mockRejectedValueOnce(new Error("no primary")).mockResolvedValue(undefined);
    const onRetry = jest.fn();
    await connectWithRetry(connect, 5, 0, onRetry);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
  });

  it("gives up after the last try and throws that error", async () => {
    const connect = jest.fn().mockRejectedValue(new Error("still down"));
    await expect(connectWithRetry(connect, 3, 0)).rejects.toThrow("still down");
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
