// sendTemplatePreview sends about 20 real emails, so the recipient is a required argument: no default address, and nothing is sent without a valid one.
import { spawnSync } from "child_process";
import path from "path";

const root = path.resolve(__dirname, "../..");
const run = (...args: string[]) =>
  spawnSync(process.execPath, ["-r", "ts-node/register/transpile-only", path.join("src", "scripts", "sendTemplatePreview.ts"), ...args], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test" },
    encoding: "utf8",
    timeout: 60_000,
  });

describe("sendTemplatePreview recipient argument", () => {
  it("exits 1 with a usage message when no address is given", () => {
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage:");
    expect(r.stderr).toContain("there is no default");
    expect(r.stdout).not.toContain("Sending");
  }, 70_000);

  it("exits 1 when the argument is not an email address", () => {
    const r = run("not-an-email");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must be an email address");
    expect(r.stdout).not.toContain("Sending");
  }, 70_000);
});
