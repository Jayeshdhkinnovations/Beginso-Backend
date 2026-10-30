import fs from "fs";
import path from "path";

/**
 * The server compose file is the contract with the VM: what it names, what it publishes, how much memory it may take. These are the facts the
 * runbook (docs/DOCKER.md, sections 3b and 4b) and scripts/check-docker-hygiene.sh rely on, so a change to any of them is a decision, not an accident.
 */
const read = (file: string) => fs.readFileSync(path.join(__dirname, "..", "..", file), "utf8").replace(/\r\n/g, "\n");
const prod = read("docker-compose.prod.yml");

describe("docker-compose.prod.yml", () => {
  it("is the beginso-api project, with one container, one network, all labelled", () => {
    expect(prod).toMatch(/^name: beginso-api$/m);
    expect(prod).toMatch(/^ {4}container_name: beginso-api$/m);
    expect(prod).toMatch(/^ {4}name: beginso-api$/m); // the network
    expect((prod.match(/com\.beginso\.app: api/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("publishes exactly one port: BIND_ADDRESS (default the loopback) : HOST_PORT (default 5000) : 5000", () => {
    const ports = prod.split("\n").filter((l) => /^\s+-\s*"[^"]*:[^"]*:\d+"\s*$/.test(l));
    expect(ports).toHaveLength(1);
    expect(ports[0].trim()).toBe('- "${BIND_ADDRESS:-127.0.0.1}:${HOST_PORT:-5000}:5000"');
  });

  it("limits memory to what this VM can spare (768 MB: about 1.1 GB is free beside the other containers)", () => {
    expect(prod).toMatch(/^ {4}mem_limit: 768m$/m);
  });

  it("runs read-only, without capabilities, never as a privileged container, never with the Docker socket", () => {
    expect(prod).toMatch(/^ {4}read_only: true$/m);
    expect(prod).toMatch(/cap_drop:\n\s+- ALL/);
    expect(prod).toMatch(/no-new-privileges:true/);
    expect(prod).not.toMatch(/privileged:/);
    expect(prod).not.toMatch(/docker\.sock/);
    expect(prod).not.toMatch(/network_mode:\s*host/);
  });

  it("the deploy script reads the same address variable and the same memory figure", () => {
    const script = read("scripts/deploy-docker.sh");
    expect(script).toContain('BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"');
    expect(script).toContain("MEM_LIMIT_MB=768");
  });
});
