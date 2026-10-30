import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import app from "../app";
import { loadBuildInfo, describeBuild } from "../utils/buildInfo";

describe("Build info on GET /", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "beginso-ver-")), "version.json");

  afterAll(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  it("reads commit id, message and deploy time from version.json", () => {
    fs.writeFileSync(file, JSON.stringify({ commit: "177c995", commitMessage: "fix the B2", deployedAt: "2026-09-28T10:00:00.000Z" }));
    const info = loadBuildInfo(file);
    expect(info).toEqual({ commit: "177c995", commitMessage: "fix the B2", deployedAt: "2026-09-28T10:00:00.000Z" });
    expect(describeBuild(info)).toBe("177c995: fix the B2");
  });

  it("falls back to unknown when version.json is missing or broken", () => {
    expect(loadBuildInfo(path.join(os.tmpdir(), "does-not-exist.json")).commit).toBeNull();
    fs.writeFileSync(file, "{ not json");
    expect(loadBuildInfo(file).commit).toBeNull();
    expect(describeBuild(loadBuildInfo(file))).toMatch(/version unknown/);
  });

  it("GET / still reports the backend as running", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/^Backend Running Successfully \(/);
    expect(res.body).toHaveProperty("commit");
  });

  // QA A15-005: the public routes used to publish the commit message and the deploy time as well.
  it("the public routes expose only the commit id, never the commit message or the deploy time", async () => {
    for (const url of ["/", "/api/health"]) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).filter((k) => ["commitMessage", "deployedAt"].includes(k))).toEqual([]);
      expect(JSON.stringify(res.body)).not.toMatch(/commitMessage|deployedAt/);
      expect(res.body).toHaveProperty("commit");
    }
  });

  it("the deploy check still works: the body contains the short commit id", async () => {
    // scripts/deploy-docker.sh checks GET / for the commit it just shipped.
    const info = require("../utils/buildInfo");
    const withCommit = { commit: "abc1234", commitMessage: "secret message", deployedAt: "2026-10-16T00:00:00.000Z" };
    expect(JSON.stringify(info.publicBuildInfo(withCommit))).toContain("abc1234");
    expect(JSON.stringify(info.publicBuildInfo(withCommit))).not.toContain("secret message");
  });
});
