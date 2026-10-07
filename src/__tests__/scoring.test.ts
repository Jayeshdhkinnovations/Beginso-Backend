// Scoring (Sprint 12, BE 0.5): criteria CRUD (workspace-scoped: /api/workspaces/:id/score-criteria),
// per-response scoring, the form score-comparison table and the CSV score columns.
process.env.JWT_SECRET = "test-jwt-secret-scoring";
process.env.RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import fs from "fs";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import ReportModel from "../models/Report";
import { generateToken } from "../utils/generateToken";
import { generateReportAsync } from "../services/report.service";

let mongo: MongoMemoryServer;
let wsA: any, wsB: any, form: any, formB: any;
let respHigh: any, respLow: any, respNone: any, respB: any;
let owner: any, admin: any, editor: any, member: any, reviewer: any, viewer: any, outsider: any;
const t: Record<string, string> = {};
const auth = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
let criterionA: string; // default criterion of workspace A
let criterionB: string; // default criterion of workspace B

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const mk = (n: string) => User.create({ firebaseUid: `uid-score-${n}`, fullName: n, email: `${n}@score.test`, status: "active" });
  [owner, admin, editor, member, reviewer, viewer, outsider] = await Promise.all(
    ["owner", "admin", "editor", "member", "reviewer", "viewer", "outsider"].map(mk)
  );
  for (const [k, u] of Object.entries({ owner, admin, editor, member, reviewer, viewer, outsider })) {
    t[k] = generateToken({ id: (u as any)._id.toString(), email: (u as any).email, role: "user" });
  }

  wsA = await Workspace.create({ name: "Score A", slug: "score-a", owner: owner._id });
  wsB = await Workspace.create({ name: "Score B", slug: "score-b", owner: outsider._id });
  await Membership.create([
    { userId: owner._id, workspaceId: wsA._id, role: "owner" },
    { userId: admin._id, workspaceId: wsA._id, role: "admin" },
    { userId: editor._id, workspaceId: wsA._id, role: "editor" },
    { userId: member._id, workspaceId: wsA._id, role: "member" },
    { userId: reviewer._id, workspaceId: wsA._id, role: "reviewer" },
    { userId: viewer._id, workspaceId: wsA._id, role: "viewer" },
    { userId: outsider._id, workspaceId: wsB._id, role: "owner" },
  ]);

  const fields: any[] = [{ fieldId: "f1", label: "Name", type: "short_text", required: false }];
  form = await Form.create({ title: "Scored", workspaceId: wsA._id, createdBy: owner._id, status: "published", fields });
  formB = await Form.create({ title: "Other tenant", workspaceId: wsB._id, createdBy: outsider._id, status: "published", fields });
  const mkResp = (f: any, ref: string) =>
    ResponseModel.create({ formId: f._id, answers: { Name: ref }, reference: ref, submittedAt: new Date() });
  respHigh = await mkResp(form, "#1");
  respLow = await mkResp(form, "#2");
  respNone = await mkResp(form, "#3");
  respB = await mkResp(formB, "#1");

  criterionA = (await request(app).get(`/api/workspaces/${wsA._id}/score-criteria`).set(auth("owner"))).body.criteria[0].id;
  criterionB = (await request(app).get(`/api/workspaces/${wsB._id}/score-criteria`).set(auth("outsider"))).body.criteria[0].id;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const base = () => `/api/workspaces/${wsA._id}/score-criteria`;

describe("score criteria CRUD", () => {
  it("lazily seeds one default criterion on first read, readable by every member role", async () => {
    for (const who of ["owner", "admin", "editor", "member", "reviewer", "viewer"]) {
      const res = await request(app).get(base()).set(auth(who));
      expect([who, res.status]).toEqual([who, 200]);
      expect(res.body.criteria).toHaveLength(1);
      expect(res.body.criteria[0]).toMatchObject({ isDefault: true, label: "", order: 0 });
    }
  });

  it("outsiders and other tenants get 403 on every verb", async () => {
    expect((await request(app).get(base()).set(auth("outsider"))).status).toBe(403);
    expect((await request(app).post(base()).set(auth("outsider")).send({ label: "x" })).status).toBe(403);
    expect((await request(app).patch(`${base()}/${criterionA}`).set(auth("outsider")).send({ label: "x" })).status).toBe(403);
    expect((await request(app).delete(`${base()}/${criterionA}`).set(auth("outsider"))).status).toBe(403);
    expect((await request(app).patch(`${base()}/order`).set(auth("outsider")).send({ orderedIds: [criterionA] })).status).toBe(403);
  });

  it("only owner/admin may change criteria (workspace:settings); editor/member/reviewer/viewer get 403", async () => {
    for (const who of ["editor", "member", "reviewer", "viewer"]) {
      expect([who, (await request(app).post(base()).set(auth(who)).send({ label: "x" })).status]).toEqual([who, 403]);
    }
    expect((await request(app).post(base()).set(auth("owner")).send({ label: "Fit" })).status).toBe(201);
    expect((await request(app).post(base()).set(auth("admin")).send({ label: "Skills" })).status).toBe(201);
  });

  it("validates label length, updates, reorders (exact id set only) and protects the default criterion", async () => {
    const list = (await request(app).get(base()).set(auth("owner"))).body.criteria;
    expect(list.map((c: any) => c.label)).toEqual(["", "Fit", "Skills"]);
    const [def, fit, skills] = list;

    expect((await request(app).post(base()).set(auth("owner")).send({ label: "x".repeat(61) })).status).toBe(422);
    const upd = await request(app).patch(`${base()}/${fit.id}`).set(auth("owner")).send({ label: "Culture fit" });
    expect(upd.status).toBe(200);
    expect(upd.body.criterion.label).toBe("Culture fit");
    expect((await request(app).patch(`${base()}/${fit.id}`).set(auth("owner")).send({})).status).toBe(422);
    expect((await request(app).patch(`${base()}/${criterionB}`).set(auth("owner")).send({ label: "hijack" })).status).toBe(404);

    const bad = await request(app).patch(`${base()}/order`).set(auth("owner")).send({ orderedIds: [def.id, fit.id] });
    expect(bad.status).toBe(400);
    const ok = await request(app).patch(`${base()}/order`).set(auth("owner")).send({ orderedIds: [skills.id, fit.id, def.id] });
    expect(ok.status).toBe(200);
    expect(ok.body.criteria.map((c: any) => c.id)).toEqual([skills.id, fit.id, def.id]);

    expect((await request(app).delete(`${base()}/${def.id}`).set(auth("owner"))).status).toBe(409);
    expect((await request(app).delete(`${base()}/${skills.id}`).set(auth("admin"))).status).toBe(204);
    expect((await request(app).delete(`${base()}/${criterionB}`).set(auth("owner"))).status).toBe(404);
    expect((await request(app).get(base()).set(auth("owner"))).body.criteria).toHaveLength(2);
  });
});

describe("PUT/GET /api/responses/:id/score", () => {
  const put = (who: string, id: any, body: any) => request(app).put(`/api/responses/${id}/score`).set(auth(who)).send(body);

  it("owner/admin/editor/member can score; reviewer/viewer can too (they hold responses:write, no delete); outsider is 403", async () => {
    for (const who of ["owner", "admin", "editor", "member"]) {
      const res = await put(who, respHigh._id, { criterionId: criterionA, value: 5 });
      expect([who, res.status]).toEqual([who, 200]);
    }
    // Reviewer/viewer hold responses:write (tag, note, score, stage), so they may score. Scored on a
    // throwaway response so the aggregates checked in later tests stay as they were.
    const scratch = await ResponseModel.create({ formId: form._id, answers: {}, reference: "#9", submittedAt: new Date() });
    expect((await put("reviewer", scratch._id, { criterionId: criterionA, value: 5 })).status).toBe(200);
    expect((await put("viewer", scratch._id, { criterionId: criterionA, value: 5 })).status).toBe(200);
    await ResponseModel.deleteOne({ _id: scratch._id });
    expect((await put("outsider", respHigh._id, { criterionId: criterionA, value: 5 })).status).toBe(403);
    expect((await request(app).get(`/api/responses/${respHigh._id}/score`).set(auth("outsider"))).status).toBe(403);
  });

  it("cross-workspace: an outsider cannot score even when claiming workspace A by header", async () => {
    const res = await request(app)
      .put(`/api/responses/${respHigh._id}/score`)
      .set({ ...auth("outsider"), "x-workspace-slug": "score-a" })
      .send({ criterionId: criterionA, value: 9 });
    expect(res.status).toBe(403);
  });

  it("rejects out-of-range / non-integer values (422) and a criterion from another workspace (404)", async () => {
    for (const value of [0, 11, 5.5, "7"]) {
      expect([value, (await put("owner", respHigh._id, { criterionId: criterionA, value })).status]).toEqual([value, 422]);
    }
    expect((await put("owner", respHigh._id, { value: 5 })).status).toBe(422);
    expect((await put("owner", respHigh._id, { criterionId: criterionB, value: 5 })).status).toBe(404);
    expect((await put("owner", respHigh._id, { criterionId: new mongoose.Types.ObjectId().toString(), value: 5 })).status).toBe(404);
    expect((await put("owner", new mongoose.Types.ObjectId(), { criterionId: criterionA, value: 5 })).status).toBe(404);
    // a response of another tenant is unreachable for A's owner
    expect((await put("owner", respB._id, { criterionId: criterionA, value: 5 })).status).toBe(403);
  });

  it("pools every reviewer's rows, upserts only the caller's own row, and GET returns only the caller's rows", async () => {
    // reset: respLow gets owner 2, editor 4 -> avg 3, count 2; respHigh already has owner/admin/editor/member = 5 each
    await put("owner", respHigh._id, { criterionId: criterionA, value: 9 });
    await put("admin", respHigh._id, { criterionId: criterionA, value: 9 });
    await put("editor", respHigh._id, { criterionId: criterionA, value: 9 });
    await put("member", respHigh._id, { criterionId: criterionA, value: 9 });
    await put("owner", respLow._id, { criterionId: criterionA, value: 2 });
    const res = await put("editor", respLow._id, { criterionId: criterionA, value: 4 });
    expect(res.status).toBe(200);
    expect(res.body.scoreAverage).toBe(3);
    expect(res.body.scoreCount).toBe(2);
    expect(res.body.entries).toEqual([{ criterionId: criterionA, value: 4 }]);

    // editor re-scores: still two reviewers, owner's row untouched
    const again = await put("editor", respLow._id, { criterionId: criterionA, value: 8 });
    expect(again.body.scoreAverage).toBe(5);
    expect(again.body.scoreCount).toBe(2);

    const get = await request(app).get(`/api/responses/${respLow._id}/score`).set(auth("owner"));
    expect(get.status).toBe(200);
    expect(get.body.entries).toEqual([{ criterionId: criterionA, value: 2 }]);
    expect(get.body.scoreAverage).toBe(5);
    // a reviewer/viewer may read scores
    expect((await request(app).get(`/api/responses/${respLow._id}/score`).set(auth("viewer"))).status).toBe(200);
  });
});

describe("GET /api/forms/:formId/score-comparison", () => {
  const cmp = (who: string, id: any, qs = "") => request(app).get(`/api/forms/${id}/score-comparison${qs}`).set(auth(who));

  it("sorts by scoreAverage (desc default, asc on request), unscored last on desc", async () => {
    const desc = await cmp("owner", form._id);
    expect(desc.status).toBe(200);
    expect(desc.body.total).toBe(3);
    expect(desc.body.rows.map((r: any) => r.reference)).toEqual(["#1", "#2", "#3"]);
    expect(desc.body.rows[0]).toMatchObject({ scoreAverage: 9, scoreCount: 4 });
    expect(desc.body.rows[2]).toMatchObject({ scoreAverage: null, scoreCount: 0 });

    const asc = await cmp("owner", form._id, "?sort=asc");
    expect(asc.body.rows.map((r: any) => r.reference)).toEqual(["#3", "#2", "#1"]);
  });

  it("is readable by viewers/reviewers (responses:read) but not by outsiders or other tenants", async () => {
    expect((await cmp("viewer", form._id)).status).toBe(200);
    expect((await cmp("reviewer", form._id)).status).toBe(200);
    expect((await cmp("outsider", form._id)).status).toBe(403);
    expect((await cmp("owner", formB._id)).status).toBe(403);
    expect((await cmp("owner", new mongoose.Types.ObjectId())).status).toBe(404);
    expect((await cmp("owner", "not-an-id")).status).toBe(404);
  });
});

describe("CSV export carries the score columns", () => {
  it("writes Score Average / Score Count per response (blank / 0 when unscored)", async () => {
    const report = await ReportModel.create({
      workspaceId: wsA._id,
      requestedBy: owner._id,
      format: "csv",
      status: "queued",
      filters: { formId: form._id.toString() },
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await generateReportAsync(report._id.toString());
    const done = await ReportModel.findById(report._id);
    expect(done!.status).toBe("completed");

    const lines = fs.readFileSync(done!.filePath as string, "utf8").trim().split("\n");
    expect(lines[0]).toBe("Response ID,Reference,Form ID,Form Title,Status,Submitted At,Score Average,Score Count,Answers");
    const row = (ref: string) => lines.find((l) => l.includes(ref))!.split(",").map((c) => c.replace(/^"|"$/g, ""));
    expect(row("#1").slice(6, 8)).toEqual(["9.00", "4"]);
    expect(row("#2").slice(6, 8)).toEqual(["5.00", "2"]);
    expect(row("#3").slice(6, 8)).toEqual(["", "0"]);
  });
});
