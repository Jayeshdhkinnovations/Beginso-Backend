/* eslint-disable no-console */
// Sprint 14 BE 0.11: seeds multi-workspace volume and times GET /api/search + the analytics endpoints (p50/p95/max).
//
//   npm run time:sprint14                       in-memory MongoDB (nothing real is touched)
//   TIMING_MONGODB_URI=<local|clone uri> TIMING_KEEP=1 npm run time:sprint14
//                                               your own LOCAL or CLONE database. It SEEDS DATA into it: never point it
//                                               at production. A URI that does not look local/test/staging/clone is refused.
// Env: WORKSPACES (default 10), FORMS (per workspace, 10), RESPONSES (per form, 300), RUNS (per endpoint, 40).
// Budget to compare with: no query > 100 ms, search p95 within the OQ-5 figure (300 ms in tasks.md).
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import { generateToken } from "../utils/generateToken";

const num = (k: string, d: number) => Number(process.env[k]) || d;
const WORKSPACES = num("WORKSPACES", 10), FORMS = num("FORMS", 10), RESPONSES = num("RESPONSES", 300), RUNS = num("RUNS", 40);

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

const main = async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "timing-only-secret";
  const given = process.env.TIMING_MONGODB_URI;
  let stop: (() => Promise<void>) | undefined;
  let uri = given;
  if (given) {
    if (!/localhost|127\.0\.0\.1|test|staging|clone|seed/i.test(given)) throw new Error("Refusing a URI that does not look local/test/staging/clone.");
  } else {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const m = await MongoMemoryServer.create();
    uri = m.getUri();
    stop = async () => { await m.stop(); };
  }
  await mongoose.connect(uri!);
  await Promise.all([Workspace, Membership, Form, ResponseModel].map((m: any) => m.init()));

  const tag = Date.now().toString(36);
  const user = await User.create({ firebaseUid: `timing-${tag}`, fullName: "Timing User", email: `timing-${tag}@timing.test`, status: "active" });
  const token = generateToken({ id: user._id.toString(), email: user.email, role: "user" });
  const first: { slug: string; formId: string } = { slug: "", formId: "" };
  for (let w = 0; w < WORKSPACES; w++) {
    const ws = await Workspace.create({ name: `Timing ${tag} ${w}`, slug: `timing-${tag}-${w}`, owner: user._id });
    await Membership.create({ userId: user._id, workspaceId: ws._id, role: "owner", notificationPreference: "none" });
    const forms = await Form.insertMany(Array.from({ length: FORMS }, (_, i) => ({
      title: `Customer intake ${w}-${i}`, workspaceId: ws._id, createdBy: user._id, status: "published",
      fields: [{ fieldId: "f1", pageId: "p1", label: "Plan", type: "dropdown", required: false, options: ["Free", "Pro", "Team"] }],
      pages: [{ id: "p1", order: 0, title: "One" }],
    })));
    for (const f of forms) {
      await ResponseModel.insertMany(Array.from({ length: RESPONSES }, (_, i) => ({
        formId: f._id, status: "new", answers: { Plan: ["Free", "Pro", "Team"][i % 3] }, reference: `#${i + 1}`,
        submittedAt: new Date(Date.now() - i * 3600_000),
      })));
    }
    if (w === 0) { first.slug = ws.slug; first.formId = String(forms[0]._id); }
  }
  console.log(`seeded ${WORKSPACES} workspaces x ${FORMS} forms x ${RESPONSES} responses = ${WORKSPACES * FORMS * RESPONSES} responses`);

  const targets: [string, string][] = [
    ["search (form title)", "/api/search?q=intake"],
    ["search (reference)", "/api/search?q=%2312"],
    ["analytics/overview", `/api/analytics/overview?formId=${first.formId}`],
    ["analytics/forms", "/api/analytics/forms?limit=50"],
    ["analytics/questions", `/api/analytics/questions?formId=${first.formId}`],
    ["analytics/trends", `/api/analytics/trends?formId=${first.formId}&bucket=day`],
  ];
  let slow = false;
  for (const [name, url] of targets) {
    const ms: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t = process.hrtime.bigint();
      const r = await request(app).get(url).set({ Authorization: `Bearer ${token}`, "x-workspace-slug": first.slug });
      ms.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (r.status !== 200) throw new Error(`${name}: HTTP ${r.status}`);
    }
    const p95 = pct(ms, 95);
    if (p95 > 100) slow = true;
    console.log(`${name.padEnd(22)} p50 ${pct(ms, 50).toFixed(1)} ms  p95 ${p95.toFixed(1)} ms  max ${Math.max(...ms).toFixed(1)} ms`);
  }
  console.log(slow ? "SOME endpoints exceed 100 ms p95 (compare with the search figure in tasks.md OQ-5)." : "All p95 under 100 ms.");

  if (given && !process.env.TIMING_KEEP) {
    await Workspace.deleteMany({ slug: new RegExp(`^timing-${tag}-`) });
    console.log("note: seeded forms/responses of this run remain; drop the clone when done.");
  }
  await mongoose.disconnect();
  await stop?.();
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
