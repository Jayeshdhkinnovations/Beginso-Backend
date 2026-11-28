// A live server once ran with TRUST_PROXY_HOPS=0 behind a proxy: for weeks no response had a map location, and nothing said why.
import express from "express";
import request from "supertest";
import { proxyCheck } from "../middleware/proxyCheck.middleware";

const appWith = (hops: number) => {
  const warn = jest.fn();
  const app = express();
  app.set("trust proxy", hops);
  app.use(proxyCheck(warn));
  app.get("/", (req, res) => void res.json({ ip: req.ip }));
  return { app, warn };
};

describe("the warning that TRUST_PROXY_HOPS is too low", () => {
  it("is said once when a proxy passes on a public visitor but the app sees only the proxy", async () => {
    const { app, warn } = appWith(0);
    await request(app).get("/").set("X-Forwarded-For", "103.21.4.9");
    await request(app).get("/").set("X-Forwarded-For", "49.36.1.1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("TRUST_PROXY_HOPS is too low");
    expect(warn.mock.calls[0][0]).not.toContain("103.21.4.9"); // a visitor's address is never written to the log
  });

  it("is also said when there are two proxies and only one is counted", async () => {
    const { app, warn } = appWith(1);
    await request(app).get("/").set("X-Forwarded-For", "103.21.4.9, 10.0.0.2");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the number is right, and the app then sees the visitor", async () => {
    const { app, warn } = appWith(1);
    const res = await request(app).get("/").set("X-Forwarded-For", "103.21.4.9");
    expect(res.body.ip).toBe("103.21.4.9");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["no proxy header at all", undefined],
    ["someone on the office network", "192.168.33.50"],
    ["a header that is not an address", "unknown"],
  ])("stays quiet for %s", async (_name, header) => {
    const { app, warn } = appWith(0);
    const call = request(app).get("/");
    await (header ? call.set("X-Forwarded-For", header) : call);
    expect(warn).not.toHaveBeenCalled();
  });
});
