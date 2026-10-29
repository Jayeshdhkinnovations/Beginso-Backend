import http from "http";
import { AddressInfo } from "net";
import { spawnSync } from "child_process";
import path from "path";
import express from "express";
import request from "supertest";
import { createShutdown } from "../utils/gracefulShutdown";
import { getRealClientIp } from "../utils/ip";

/**
 * What the container relies on: a stop that lets a running request finish, a client IP that cannot be forged, and a start-up that
 * refuses to run in production when a required setting is missing (and names it, never its value).
 */

describe("graceful shutdown (SIGTERM from Docker or pm2)", () => {
  it("lets a request that is still running finish, closes the database, then exits 0", async () => {
    const order: string[] = [];
    const app = express();
    app.get("/slow", (_req, res) => {
      order.push("request started");
      setTimeout(() => {
        order.push("request finished");
        res.json({ ok: true });
      }, 300);
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const exit = jest.fn((code: number) => order.push(`exit ${code}`));
    const shutdown = createShutdown(server, { timeoutMs: 5000, exit, log: () => {}, closeDb: async () => { order.push("db closed"); } });

    const inFlight = request(`http://127.0.0.1:${port}`).get("/slow");
    const response = new Promise<request.Response>((resolve, reject) => inFlight.end((err, res) => (err ? reject(err) : resolve(res))));
    await new Promise((resolve) => setTimeout(resolve, 100)); // the request is running
    await shutdown("SIGTERM");

    expect((await response).status).toBe(200);
    expect(order).toEqual(["request started", "request finished", "db closed", "exit 0"]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("leaves after the timeout when a request never finishes, and a second signal does nothing", async () => {
    const exit = jest.fn();
    const server = { close: jest.fn(), closeIdleConnections: jest.fn() }; // close() never calls back: a request that never ends
    const shutdown = createShutdown(server as never, { timeoutMs: 50, exit, log: () => {} });
    void shutdown("SIGTERM");
    void shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still exits when closing the database fails", async () => {
    const exit = jest.fn();
    const server = { close: (cb: () => void) => cb(), closeIdleConnections: jest.fn() };
    await createShutdown(server as never, { exit, log: () => {}, closeDb: async () => { throw new Error("boom"); } })("SIGINT");
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("client IP behind Docker and a proxy", () => {
  const appWith = (hops: number) => {
    const app = express();
    app.set("trust proxy", hops);
    app.get("/ip", (req, res) => res.json({ ip: getRealClientIp(req) }));
    return app;
  };
  const savedSecret = process.env.PROXY_SHARED_SECRET;
  beforeEach(() => { process.env.PROXY_SHARED_SECRET = "s3cret-for-this-test-only"; });
  afterAll(() => { if (savedSecret === undefined) delete process.env.PROXY_SHARED_SECRET; else process.env.PROXY_SHARED_SECRET = savedSecret; });

  it("believes X-Forwarded-For only when a proxy is trusted (hops >= 1)", async () => {
    const trusted = await request(appWith(1)).get("/ip").set("X-Forwarded-For", "203.0.113.7");
    expect(trusted.body.ip).toBe("203.0.113.7");
    const untrusted = await request(appWith(0)).get("/ip").set("X-Forwarded-For", "203.0.113.7");
    expect(untrusted.body.ip).not.toBe("203.0.113.7");
  });

  it("with one trusted proxy a caller cannot choose their own address by putting extra entries in front", async () => {
    const res = await request(appWith(1)).get("/ip").set("X-Forwarded-For", "6.6.6.6, 203.0.113.7");
    expect(res.body.ip).toBe("203.0.113.7"); // the entry the proxy added, not the one the caller invented
  });

  it("believes x-client-ip only together with the shared secret", async () => {
    const withSecret = await request(appWith(0)).get("/ip").set("x-client-ip", "198.51.100.9").set("x-proxy-secret", "s3cret-for-this-test-only");
    expect(withSecret.body.ip).toBe("198.51.100.9");
    const wrongSecret = await request(appWith(0)).get("/ip").set("x-client-ip", "198.51.100.9").set("x-proxy-secret", "nope");
    expect(wrongSecret.body.ip).not.toBe("198.51.100.9");
    const noSecret = await request(appWith(0)).get("/ip").set("x-client-ip", "198.51.100.9");
    expect(noSecret.body.ip).not.toBe("198.51.100.9");
  });
});

describe("docker/preflight.js (runs before the server inside the container)", () => {
  const script = path.join(__dirname, "..", "..", "docker", "preflight.js");
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  const complete = {
    NODE_ENV: "production",
    JWT_SECRET: "value-that-must-never-be-printed-1",
    MONGODB_URI: "mongodb://value-that-must-never-be-printed-2",
    PROXY_SHARED_SECRET: "value-that-must-never-be-printed-3",
    APP_URL: "https://example.test",
    SMTP_HOST: "smtp.example.test",
    SMTP_USER: "user",
    SMTP_PASS: "value-that-must-never-be-printed-4",
    SMTP_FROM_EMAIL: "no-reply@example.test",
  };

  it("in production names every missing setting, exits 1, and never prints a value", () => {
    const { JWT_SECRET: _a, SMTP_PASS: _b, ...rest } = complete;
    void _a; void _b;
    const result = run(rest);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("JWT_SECRET is missing");
    expect(result.stderr).toContain("SMTP_PASS is missing");
    expect(result.stderr).not.toContain("must-never-be-printed");
  });

  it("outside production it only warns", () => {
    const result = run({ NODE_ENV: "development" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("WARN");
  });
});
