import fs from "fs";
import path from "path";

export interface AuditSummary {
  total: number;
  critical: number;
  high: number;
  checkedAt: string | null;
}

// audit.json is written by the deploy workflow next to version.json (dist/audit.json) from `npm audit --omit=dev`.
// It does not exist in local development, where the result is simply reported as not recorded (null).
export const parseAuditSummary = (raw: unknown): AuditSummary | null => {
  const r = raw as { total?: unknown; critical?: unknown; high?: unknown; checkedAt?: unknown } | null;
  if (!r || typeof r.total !== "number" || typeof r.critical !== "number" || typeof r.high !== "number") return null;
  return { total: r.total, critical: r.critical, high: r.high, checkedAt: typeof r.checkedAt === "string" ? r.checkedAt : null };
};

export const loadAuditInfo = (file: string): AuditSummary | null => {
  try {
    return parseAuditSummary(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
};

export const auditInfo = loadAuditInfo(path.join(__dirname, "..", "audit.json"));
