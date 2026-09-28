import fs from "fs";
import path from "path";

export interface BuildInfo {
  commit: string | null;
  commitMessage: string | null;
  deployedAt: string | null;
}

const UNKNOWN: BuildInfo = { commit: null, commitMessage: null, deployedAt: null };

// version.json is written by the deploy workflow next to the compiled code (dist/version.json).
// It does not exist in local development, where the version is simply reported as unknown.
export const loadBuildInfo = (file: string): BuildInfo => {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      commit: typeof raw.commit === "string" ? raw.commit : null,
      commitMessage: typeof raw.commitMessage === "string" ? raw.commitMessage : null,
      deployedAt: typeof raw.deployedAt === "string" ? raw.deployedAt : null,
    };
  } catch {
    return UNKNOWN;
  }
};

export const buildInfo = loadBuildInfo(path.join(__dirname, "..", "version.json"));

export const describeBuild = (info: BuildInfo): string =>
  info.commit ? `${info.commit}: ${info.commitMessage ?? ""}`.trim() : "version unknown (local build)";
