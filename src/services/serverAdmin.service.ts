import os from "os";
import fs from "fs";
import { StringDecoder } from "string_decoder";
import mongoose from "mongoose";
import { getDockerProxyConfig, CONTAINER_NAME_RE } from "../config/dockerProxy";
import { cachedFor } from "../utils/ttlCache";
import { redactLine, redactBlock } from "../utils/redactLog";
import { Logger } from "../utils/logger";
import { audit, type Actor } from "./superadminOps.service";
import { getUploadDir } from "../controllers/upload.controller";
import type { LogLevel, LogsQuery } from "../validations/serverAdmin.validator";

// Read-only view of the VM's Docker containers for the super admin console (the Server page): the equivalent of `docker ps`, the container
// logs, and a small health panel.
//
// SAFETY, the whole point of this file:
//  - No docker binary, no shell, no child_process, no docker.sock in this container. The only door is a Docker Engine API behind a
//    read-only socket proxy (DOCKER_PROXY_URL), called with Node's global fetch.
//  - The code calls EXACTLY three Engine paths, built only by the three functions listCall(), statsCall() and logsCall() below:
//        GET /containers/json?all=1
//        GET /containers/<id>/stats?stream=false
//        GET /containers/<id>/logs?stdout=1&stderr=1&timestamps=1&tail=<n>&since=<unix seconds>
//    Never inspect (/containers/<id>/json), export, archive, exec or top. Nothing from inspect (environment, labels, mounts, networks,
//    command line) is ever returned: the answers below are built field by field from the list and stats responses.
//  - Only containers named in ADMIN_VISIBLE_CONTAINERS exist for this feature. Any other name answers 404 "Container not found", the same
//    answer as for a name that does not exist. The logs call uses the container id taken from the list answer, never the request string.
//  - Docker's own error bodies are never forwarded: a failure is "The Docker proxy did not answer" (502).
//  - Log text is redacted (utils/redactLog.ts) before it is searched, filtered or sent.

const CALL_TIMEOUT_MS = 5000;
const STATS_TIMEOUT_MS = 4000;
const LIST_CACHE_MS = 5000;
const LIST_BODY_CAP = 4 * 1024 * 1024;
const STATS_BODY_CAP = 1024 * 1024;
const LOG_BODY_CAP = 4 * 1024 * 1024; // raw bytes read from Docker: reading stops here
export const RESPONSE_CAP_CHARS = 1_000_000; // about 1 MB of JSON text in the answer: the newest entries are kept
const CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/;

const httpError = (statusCode: number, message: string): Error => Object.assign(new Error(message), { statusCode });
const notFound = () => httpError(404, "Container not found");
const proxyDown = () => httpError(502, "The Docker proxy did not answer");

// ---------------------------------------------------------------- the only three Engine calls

const listCall = () => "/containers/json?all=1";
const statsCall = (id: string) => `/containers/${id}/stats?stream=false`;
const logsCall = (id: string, tail: number, sinceUnix: number) => `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}&since=${sinceUnix}`;

/** GET one of the paths above and read the body up to `cap` bytes. Any failure (network, timeout, non-2xx) becomes a plain Error with no detail. */
async function dockerGet(baseUrl: string, path: string, timeoutMs: number, cap: number): Promise<{ body: Buffer; capped: boolean }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined); // the error body is never read or forwarded
    throw new Error("docker call failed");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let capped = false;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = cap - size;
      if (value.length >= room) {
        chunks.push(Buffer.from(value.subarray(0, room)));
        size += room;
        capped = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(Buffer.from(value));
      size += value.length;
    }
  }
  return { body: Buffer.concat(chunks), capped };
}

interface RawContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: unknown[];
}

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.slice(0, max) : "");

/** The list answer reduced to the few fields used here; everything else Docker sends is dropped on the spot. */
async function fetchList(baseUrl: string, timeoutMs = CALL_TIMEOUT_MS): Promise<RawContainer[]> {
  const { body } = await dockerGet(baseUrl, listCall(), timeoutMs, LIST_BODY_CAP);
  const parsed = JSON.parse(body.toString("utf8"));
  if (!Array.isArray(parsed)) throw new Error("unexpected list answer");
  return parsed
    .filter((c) => c && typeof c === "object")
    .map((c: any) => ({
      id: str(c.Id, 80),
      name: str(Array.isArray(c.Names) ? c.Names[0] : "", 200).replace(/^\//, ""),
      image: str(c.Image),
      state: str(c.State, 40),
      status: str(c.Status),
      created: Number(c.Created) || 0,
      ports: Array.isArray(c.Ports) ? c.Ports : [],
    }))
    .filter((c) => c.name);
}

// ---------------------------------------------------------------- containers

export interface ContainerRow {
  name: string;
  image: string;
  state: string;
  health: "healthy" | "unhealthy" | "starting" | "none";
  status: string;
  createdAt: string | null;
  ports: string[];
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryLimitBytes: number | null;
}

export const healthOf = (status: string): ContainerRow["health"] =>
  status.includes("(unhealthy)") ? "unhealthy" : status.includes("(healthy)") ? "healthy" : status.includes("(health: starting)") ? "starting" : "none";

export function portsOf(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const p of raw as any[]) {
    const priv = Number(p?.PrivatePort);
    if (!Number.isFinite(priv)) continue;
    const type = str(p?.Type, 8) || "tcp";
    const pub = Number(p?.PublicPort);
    const ip = str(p?.IP, 64);
    const text = Number.isFinite(pub) && pub > 0 ? `${ip ? `${ip}:` : ""}${pub}->${priv}/${type}` : `${priv}/${type}`;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** CPU and memory out of one stats sample; null for anything the sample does not carry. */
export function statsOf(s: any): { cpuPercent: number | null; memoryUsedBytes: number | null; memoryLimitBytes: number | null } {
  const cpuDelta = (num(s?.cpu_stats?.cpu_usage?.total_usage) ?? NaN) - (num(s?.precpu_stats?.cpu_usage?.total_usage) ?? NaN);
  const sysDelta = (num(s?.cpu_stats?.system_cpu_usage) ?? NaN) - (num(s?.precpu_stats?.system_cpu_usage) ?? NaN);
  const percpu = s?.cpu_stats?.cpu_usage?.percpu_usage;
  const cpus = num(s?.cpu_stats?.online_cpus) ?? (Array.isArray(percpu) ? percpu.length : null) ?? 1;
  const cpuPercent = cpuDelta > 0 && sysDelta > 0 ? round((cpuDelta / sysDelta) * cpus * 100) : null;

  const usage = num(s?.memory_stats?.usage);
  const cache = num(s?.memory_stats?.stats?.inactive_file) ?? num(s?.memory_stats?.stats?.cache) ?? 0; // cgroup v2 / v1
  return {
    cpuPercent,
    memoryUsedBytes: usage === null ? null : Math.max(0, usage - cache),
    memoryLimitBytes: num(s?.memory_stats?.limit),
  };
}

async function sample(baseUrl: string, id: string) {
  try {
    const { body } = await dockerGet(baseUrl, statsCall(id), STATS_TIMEOUT_MS, STATS_BODY_CAP);
    return statsOf(JSON.parse(body.toString("utf8")));
  } catch {
    return { cpuPercent: null, memoryUsedBytes: null, memoryLimitBytes: null };
  }
}

export const NOT_CONFIGURED_STEPS = [
  "Add a Docker socket proxy container (for example tecnativa/docker-socket-proxy) on a private network that only the API container shares.",
  "Give the proxy CONTAINERS=1 and POST=0 and leave every other permission at 0; do not publish any port of it.",
  "Set DOCKER_PROXY_URL (for example http://docker-proxy:2375) and ADMIN_VISIBLE_CONTAINERS (the container names to show, comma separated) in the API environment.",
  "Restart the API container so it reads the new settings.",
  "Rollback: remove DOCKER_PROXY_URL from the environment and restart the API; this page then shows these steps again.",
];

export async function listContainers() {
  const cfg = getDockerProxyConfig();
  if (!cfg.configured) return { configured: false as const, reason: cfg.reason, steps: NOT_CONFIGURED_STEPS };

  try {
    const cached = await cachedFor("server-containers", LIST_CACHE_MS, async () => {
      const list = (await fetchList(cfg.baseUrl)).filter((c) => cfg.allowed.includes(c.name));
      const rows = await Promise.all(
        list.map(async (c): Promise<ContainerRow> => {
          const stats = c.state === "running" ? await sample(cfg.baseUrl, c.id) : { cpuPercent: null, memoryUsedBytes: null, memoryLimitBytes: null };
          return {
            name: c.name,
            image: c.image,
            state: c.state,
            health: healthOf(c.status),
            status: c.status,
            createdAt: c.created > 0 ? new Date(c.created * 1000).toISOString() : null,
            ports: portsOf(c.ports),
            ...stats,
          };
        }),
      );
      return rows.sort((a, b) => a.name.localeCompare(b.name));
    });
    return { configured: true as const, containers: cached.value, computedAt: cached.computedAt };
  } catch {
    throw proxyDown();
  }
}

// ---------------------------------------------------------------- logs

export interface LogEntry {
  ts: string | null;
  stream: "stdout" | "stderr";
  level: LogLevel;
  text: string;
  stack?: string;
}

type RawLine = { stream: "stdout" | "stderr"; line: string };

/** Docker's multiplexed stream: 8-byte header (byte 0 = 1 stdout / 2 stderr, bytes 4-7 = big-endian length) + payload. */
const isFrameHeader = (b: Buffer, pos: number): boolean =>
  b.length - pos >= 8 && b[pos] <= 2 && b[pos + 1] === 0 && b[pos + 2] === 0 && b[pos + 3] === 0;

/** Splits a raw log body into lines tagged with their stream. A body that is not multiplexed (a container with a TTY) is plain stdout. */
export function demux(body: Buffer): RawLine[] {
  const out: RawLine[] = [];
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const pending = { stdout: "", stderr: "" };
  const feed = (stream: "stdout" | "stderr", text: string) => {
    const parts = (pending[stream] + text).split("\n");
    pending[stream] = parts.pop() ?? "";
    for (const line of parts) out.push({ stream, line: line.replace(/\r$/, "") });
  };

  if (!isFrameHeader(body, 0)) {
    feed("stdout", decoders.stdout.write(body) + decoders.stdout.end());
  } else {
    let pos = 0;
    while (pos < body.length) {
      if (!isFrameHeader(body, pos)) {
        feed("stdout", decoders.stdout.write(body.subarray(pos))); // broken framing: keep the rest as plain text
        break;
      }
      const stream = body[pos] === 2 ? "stderr" : "stdout";
      const end = Math.min(body.length, pos + 8 + body.readUInt32BE(pos + 4)); // a last frame cut by the read cap is used as far as it goes
      feed(stream, decoders[stream].write(body.subarray(pos + 8, end)));
      pos = end;
    }
    feed("stdout", decoders.stdout.end());
    feed("stderr", decoders.stderr.end());
  }
  for (const stream of ["stdout", "stderr"] as const) if (pending[stream]) out.push({ stream, line: pending[stream] });
  return out;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2}) ?/;

function splitTimestamp(line: string): { ts: string | null; text: string } {
  const m = TIMESTAMP.exec(line);
  if (!m) return { ts: null, text: line };
  const millis = (m[2] ?? ".000").slice(1, 4).padEnd(3, "0"); // nanoseconds -> milliseconds
  const d = new Date(`${m[1]}.${millis}${m[3]}`);
  return { ts: Number.isNaN(d.getTime()) ? null : d.toISOString(), text: line.slice(m[0].length) };
}

export function levelOf(text: string): LogLevel {
  const bracket = /^\s*\[(info|warn|error)\]/i.exec(text);
  if (bracket) return bracket[1].toLowerCase() as LogLevel;
  const t = text.trimStart();
  if (t.startsWith("{") && t.length <= 20000) {
    try {
      const lv = JSON.parse(t)?.level;
      if (typeof lv === "number") return lv <= 30 ? "info" : lv < 50 ? "warn" : "error";
      if (typeof lv === "string") {
        const s = lv.toLowerCase();
        if (s === "info") return "info";
        if (s === "warn" || s === "warning") return "warn";
        if (s === "error" || s === "fatal") return "error";
      }
    } catch {
      /* not JSON */
    }
  }
  return "unknown";
}

const STACK_FRAME = /^\s+at\s/;

/** Raw lines -> entries; stack frames are joined into the `stack` of the entry before them. Text is NOT redacted here. */
export function buildEntries(lines: RawLine[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const { stream, line } of lines) {
    const { ts, text } = splitTimestamp(line);
    const prev = entries[entries.length - 1];
    if (STACK_FRAME.test(text) && prev) {
      prev.stack = prev.stack === undefined ? text : `${prev.stack}\n${text}`;
      continue;
    }
    entries.push({ ts, stream, level: levelOf(text), text });
  }
  return entries;
}

/** Redact, then search (plain, case-insensitive substring) and level filter, then keep the newest entries that fit the response cap. */
export function prepareEntries(entries: LogEntry[], opts: { search?: string; levels?: LogLevel[] }): { entries: LogEntry[]; truncated: boolean } {
  const needle = opts.search ? opts.search.toLowerCase() : "";
  const levels = opts.levels ? new Set<LogLevel>(opts.levels) : null;
  const kept: LogEntry[] = [];
  for (const e of entries) {
    const text = redactLine(e.text);
    const stack = e.stack === undefined ? undefined : redactBlock(e.stack);
    if (levels && !levels.has(e.level)) continue;
    if (needle && !text.toLowerCase().includes(needle) && !(stack ?? "").toLowerCase().includes(needle)) continue;
    kept.push({ ts: e.ts, stream: e.stream, level: e.level, text, ...(stack === undefined ? {} : { stack }) });
  }
  let size = 0;
  let from = kept.length;
  while (from > 0) {
    const cost = JSON.stringify(kept[from - 1]).length + 1;
    if (size + cost > RESPONSE_CAP_CHARS) break;
    size += cost;
    from--;
  }
  return { entries: kept.slice(from), truncated: from > 0 };
}

// One audit row per (user, container, tail, since) per 10 minutes. Follow mode polls every 3 s and the search box refetches while typing:
// without this the immutable audit log would fill up. In memory and per instance; bounded; the first request of a combination always counts.
const AUDIT_EVERY_MS = 10 * 60 * 1000;
const AUDIT_MAP_MAX = 1000;
const auditSeen = new Map<string, number>();

export function resetLogAuditDedupe(): void {
  auditSeen.clear();
}

async function auditLogsViewed(actor: Actor, container: string, tail: number, since: number): Promise<void> {
  const key = `${actor.id}|${container}|${tail}|${since}`;
  const now = Date.now();
  const until = auditSeen.get(key);
  if (until !== undefined && until > now) return;
  if (auditSeen.size >= AUDIT_MAP_MAX) {
    for (const [k, v] of auditSeen) if (v <= now) auditSeen.delete(k);
    while (auditSeen.size >= AUDIT_MAP_MAX) auditSeen.delete(auditSeen.keys().next().value as string); // oldest first (insertion order)
  }
  auditSeen.set(key, now + AUDIT_EVERY_MS);
  try {
    // Only the container, the line count and the window: never the log text and never the search text.
    await audit(actor, "superadmin.server.logs_viewed", "server", container, undefined, { container, tail, window: since });
  } catch (error) {
    auditSeen.delete(key); // try again on the next request
    Logger.error("Could not write the server logs audit row", error).catch(() => undefined);
  }
}

export async function getContainerLogs(actor: Actor, name: string, query: LogsQuery) {
  const cfg = getDockerProxyConfig();
  if (!cfg.configured || typeof name !== "string" || !CONTAINER_NAME_RE.test(name) || !cfg.allowed.includes(name)) throw notFound();

  let id: string;
  try {
    const found = (await fetchList(cfg.baseUrl)).find((c) => c.name === name);
    if (!found || !CONTAINER_ID_RE.test(found.id)) throw notFound();
    id = found.id;
  } catch (error: any) {
    throw error?.statusCode === 404 ? error : proxyDown();
  }

  await auditLogsViewed(actor, name, query.tail, query.since);

  let body: Buffer;
  try {
    const sinceUnix = Math.floor(Date.now() / 1000) - query.since;
    ({ body } = await dockerGet(cfg.baseUrl, logsCall(id, query.tail, sinceUnix), CALL_TIMEOUT_MS, LOG_BODY_CAP));
  } catch {
    throw proxyDown();
  }

  const { entries, truncated } = prepareEntries(buildEntries(demux(body)), { search: query.search, levels: query.level });
  return { container: name, entries, truncated, tail: query.tail, since: query.since, computedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- health

const DB_STATES: Record<number, string> = { 0: "disconnected", 1: "connected", 2: "connecting", 3: "disconnecting" };

async function databaseHealth() {
  const state = DB_STATES[mongoose.connection.readyState] ?? "unknown";
  let pingMs: number | null = null;
  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    const t0 = process.hrtime.bigint();
    try {
      await mongoose.connection.db.admin().ping();
      pingMs = round(Number(process.hrtime.bigint() - t0) / 1e6);
    } catch {
      pingMs = null;
    }
  }
  return { state, pingMs, lastPingAt: new Date().toISOString() };
}

function hostHealth() {
  try {
    return {
      available: true as const,
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg().map((n) => round(n)) as [number, number, number],
      memoryTotalBytes: os.totalmem(),
      memoryFreeBytes: os.freemem(),
      uptimeSeconds: Math.round(os.uptime()),
    };
  } catch {
    return { available: false as const, reason: "Host figures are not available here." };
  }
}

// Size of the disk that holds the uploads. The path itself is never returned.
async function dataVolumeHealth() {
  try {
    const s = await fs.promises.statfs(getUploadDir());
    return { available: true as const, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch {
    return { available: false as const, reason: "The data volume could not be read." };
  }
}

async function dockerProxyHealth() {
  const cfg = getDockerProxyConfig();
  if (!cfg.configured) return { configured: false, reachable: null };
  try {
    await fetchList(cfg.baseUrl, 3000);
    return { configured: true, reachable: true };
  } catch {
    return { configured: true, reachable: false };
  }
}

export async function getServerHealth() {
  const [database, dataVolume, dockerProxy] = await Promise.all([databaseHealth(), dataVolumeHealth(), dockerProxyHealth()]);
  return {
    api: { ready: true, uptimeSeconds: Math.round(process.uptime()), nodeVersion: process.version },
    database,
    host: hostHealth(),
    dataVolume,
    dockerProxy,
    computedAt: new Date().toISOString(),
  };
}
