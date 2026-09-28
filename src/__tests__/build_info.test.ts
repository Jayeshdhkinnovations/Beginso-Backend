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
});
