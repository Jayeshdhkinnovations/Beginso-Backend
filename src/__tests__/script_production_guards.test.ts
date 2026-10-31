// The seed and test-data scripts write to the database, so each one must stop (exit 1, with a clear message) when NODE_ENV is "production",
// before it loads anything else or connects. seedSuperAdmin is the only way to create the first super admin, so it is allowed in production,
// but only with ALLOW_SUPERADMIN_BOOTSTRAP=yes for that run.
import { spawnSync } from "child_process";
import path from "path";
import { refuseInProduction, requireBootstrapFlag } from "../scripts/_guard";

const root = path.resolve(__dirname, "../..");
const nodeBin = process.execPath;

const run = (script: string, env: Record<string, string>) =>
  spawnSync(nodeBin, ["-r", "ts-node/register/transpile-only", path.join("src", "scripts", script)], {
    cwd: root,
    env: { ...process.env, MONGODB_URI: "mongodb://127.0.0.1:1/never-connected", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });

describe("scripts that write test data refuse to run in production", () => {
  const scripts = [
    "seedFieldShowcase.ts",
    "seedFullForm.ts",
    "seedTestUsers.ts",
    "seedUserResponses.ts",
    "seedV2aVolume.ts",
    "timeSearchAndAnalytics.ts",
  ];

  it.each(scripts)("%s exits 1 with a clear message when NODE_ENV=production", (script) => {
    const r = run(script, { NODE_ENV: "production" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`Refusing to run ${script}`);
    expect(r.stderr).toContain('NODE_ENV is "production"');
    expect(r.stderr).toContain("ALLOW_DESTRUCTIVE_SEED=yes");
  }, 70_000);
});

describe("seedSuperAdmin in production", () => {
  it("is refused without the explicit flag, and says what to set", () => {
    const r = run("seedSuperAdmin.ts", { NODE_ENV: "production" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Refusing to create or update super admins");
    expect(r.stderr).toContain("ALLOW_SUPERADMIN_BOOTSTRAP=yes");
  }, 70_000);

  it("is refused when the flag has any other value", () => {
    const r = run("seedSuperAdmin.ts", { NODE_ENV: "production", ALLOW_SUPERADMIN_BOOTSTRAP: "true" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ALLOW_SUPERADMIN_BOOTSTRAP=yes");
  }, 70_000);
});

describe("the guard helpers", () => {
  const original = { ...process.env };
  let exit: jest.SpyInstance;
  let err: jest.SpyInstance;
  beforeEach(() => {
    exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    err = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    exit.mockRestore();
    err.mockRestore();
    process.env = { ...original };
  });

  it("refuseInProduction does nothing outside production, and in production only with ALLOW_DESTRUCTIVE_SEED=yes", () => {
    process.env.NODE_ENV = "development";
    refuseInProduction("x");
    process.env.NODE_ENV = "production";
    process.env.ALLOW_DESTRUCTIVE_SEED = "yes";
    refuseInProduction("x");
    expect(exit).not.toHaveBeenCalled();
    delete process.env.ALLOW_DESTRUCTIVE_SEED;
    refuseInProduction("x");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("requireBootstrapFlag lets the run through outside production, and in production only with ALLOW_SUPERADMIN_BOOTSTRAP=yes", () => {
    process.env.NODE_ENV = "development";
    requireBootstrapFlag("x");
    process.env.NODE_ENV = "production";
    process.env.ALLOW_SUPERADMIN_BOOTSTRAP = "yes";
    requireBootstrapFlag("x");
    expect(exit).not.toHaveBeenCalled();
    delete process.env.ALLOW_SUPERADMIN_BOOTSTRAP;
    requireBootstrapFlag("x");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
