// "Customize" on a form's Responses page: the stages of one form, its table columns, board card and defaults, saved in one step by an
// owner or admin. GET/PUT /api/forms/:formId/response-setup. A form with no saved setup looks exactly as it always did.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import ResponseSetup from "../models/ResponseSetup";
import StageModel from "../models/Stage";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { generateToken } from "../utils/generateToken";
import { clearRateLimitStore } from "../middleware/rateLimiter";
import { deleteFormData } from "../services/cleanup.service";

process.env.JWT_SECRET = "test-jwt-secret-key-for-response-setup";

let mongo: MongoMemoryServer;
let ws: any;
let headers: Record<string, Record<string, string>>; // by role
let n = 0;

const head = (user: any) => ({ Authorization: `Bearer ${generateToken({ id: user._id.toString(), email: user.email, role: "user" })}`, "x-workspace-slug": "rs-ws" });

const mkForm = (extra: any = {}) => {
  n += 1;
  return Form.create({
    title: `Setup form ${n}`, workspaceId: ws._id, createdBy: undefined, status: "published", slug: `rs-${n}`, publishedSlug: `rs-${n}`,
    fields: [
      { fieldId: "f-name", label: "Full name", type: "short_text", required: false },
      { fieldId: "f-film", label: "Film title", type: "short_text", required: false },
    ],
    ...extra,
  } as any) as Promise<any>;
};
const get = (f: any, role = "owner") => request(app).get(`/api/forms/${f._id}/response-setup`).set(headers[role]);
const put = (f: any, body: object, role = "owner") => request(app).put(`/api/forms/${f._id}/response-setup`).set(headers[role]).send(body);

const OWN = [
  { name: "Received", colour: "slate", category: "new" },
  { name: "Screening", colour: "amber", category: "in_progress" },
  { name: "Shortlisted", colour: "sky", category: "in_progress" },
  { name: "Selected", colour: "emerald", category: "completed" },
];
const body = (over: any = {}) => ({
  version: 0,
  stages: { mode: "workspace" },
  tableColumns: ["respondent", "email", "stage", "submitted"],
  cardTitle: "auto",
  opensAs: "table",
  sort: "newest",
  respondentFrom: "auto",
  rowHeight: "comfortable",
  wrap: false,
  ...over,
});

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const mk = async (name: string, role: string) => {
    const u: any = await User.create({ firebaseUid: `uid-rs-${name}`, fullName: name, email: `rs-${name}@test.com`, role: "admin", status: "active" });
    return { u, role };
  };
  const owner = await mk("owner", "owner");
  ws = await Workspace.create({ name: "RS WS", slug: "rs-ws", timezone: "UTC", owner: owner.u._id });
  headers = {};
  for (const { u, role } of [owner, await mk("admin", "admin"), await mk("member", "member"), await mk("viewer", "viewer")]) {
    await Membership.create({ userId: u._id, workspaceId: ws._id, role: role as any });
    headers[role] = head(u);
  }
});
beforeEach(() => clearRateLimitStore());
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const seedResponses = async (f: any) => {
  // one response in each workspace stage, written the way a submission would
  const stages = await StageModel.find({ workspaceId: ws._id, formId: null }).sort({ order: 1 });
  const rows = [];
  for (const s of stages) rows.push({ formId: f._id, answers: { "Full name": `in ${s.name}` }, stageId: s._id, status: s.category, boardRank: 5 });
  return (await ResponseModel.create(rows)) as any[];
};

describe("GET /api/forms/:formId/response-setup", () => {
  it("a form nobody customised gets today's setup and the workspace stages", async () => {
    const f = await mkForm();
    const res = await get(f);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(0);
    expect(res.body.setup).toEqual({
      tableColumns: ["respondent", "email", "tags", "assignee", "stage", "submitted"],
      cardTitle: "auto", opensAs: "table", sort: "newest", respondentFrom: "auto", rowHeight: "comfortable", wrap: false,
    });
    expect(res.body.stages.mode).toBe("workspace");
    expect(res.body.stages.list.map((s: any) => s.name)).toEqual(["New", "In Progress", "Completed"]);
  });

  it("every role that can read the form can read the setup", async () => {
    const f = await mkForm();
    for (const role of ["owner", "admin", "member", "viewer"]) expect((await get(f, role)).status).toBe(200);
  });
});

describe("PUT /api/forms/:formId/response-setup: who", () => {
  it("an owner and an admin may save it; a member and a viewer may not", async () => {
    const f = await mkForm();
    expect((await put(f, body(), "viewer")).status).toBe(403);
    expect((await put(f, body(), "member")).status).toBe(403);
    expect((await put(f, body(), "admin")).status).toBe(200);
    const again = await get(f);
    expect(again.body.version).toBe(1);
    expect((await put(f, body({ version: 1 }), "owner")).status).toBe(200);
  });
});

describe("PUT: the setup", () => {
  it("saves columns, card, defaults, and reads them back; a question can be a column", async () => {
    const f = await mkForm();
    const res = await put(f, body({ tableColumns: ["respondent", "q:f-film", "stage"], cardTitle: "f-film", opensAs: "board", sort: "oldest", respondentFrom: "f-name", rowHeight: "compact", wrap: true }));
    expect(res.status).toBe(200);
    expect(res.body.setup).toEqual({ tableColumns: ["respondent", "q:f-film", "stage"], cardTitle: "f-film", opensAs: "board", sort: "oldest", respondentFrom: "f-name", rowHeight: "compact", wrap: true });
    expect((await get(f)).body.setup.tableColumns).toEqual(["respondent", "q:f-film", "stage"]);
  });

  it("refuses an unknown column, an unknown question, a repeated column, no columns, and too many stages", async () => {
    const f = await mkForm();
    expect((await put(f, body({ tableColumns: ["respondent", "nonsense"] }))).status).toBe(422);
    expect((await put(f, body({ tableColumns: ["q:not-a-question"] }))).status).toBe(422);
    expect((await put(f, body({ cardTitle: "not-a-question" }))).status).toBe(422);
    expect((await put(f, body({ tableColumns: ["email", "email"] }))).status).toBe(422);
    expect((await put(f, body({ tableColumns: [] }))).status).toBe(422);
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `S${i}`, colour: "slate", category: "new" }));
    expect((await put(f, body({ stages: { mode: "own", stages: many } }))).status).toBe(422);
  });

  it("a stale save is a 409 and changes nothing", async () => {
    const f = await mkForm();
    expect((await put(f, body())).status).toBe(200); // version is now 1
    const stale = await put(f, body({ version: 0, cardTitle: "f-film" }));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("RESPONSE_SETUP_STALE");
    expect((await get(f)).body.setup.cardTitle).toBe("auto");
  });

  it("a question deleted later just disappears from the table and the card falls back", async () => {
    const f = await mkForm();
    await put(f, body({ tableColumns: ["respondent", "q:f-film"], cardTitle: "f-film" }));
    await Form.updateOne({ _id: f._id, "fields.fieldId": "f-film" }, { $set: { "fields.$.deleted": true } });
    const res = await get(f);
    expect(res.body.setup.tableColumns).toEqual(["respondent"]);
    expect(res.body.setup.cardTitle).toBe("auto");
  });
});

describe("PUT: the stages of one form", () => {
  it("giving a form its own stages moves each response to the first stage that counts the same way, and clears hand-placed order", async () => {
    const f = await mkForm();
    const [rNew, rProgress, rDone] = await seedResponses(f);
    const res = await put(f, body({ stages: { mode: "own", stages: OWN, startIndex: 1 } }));
    expect(res.status).toBe(200);
    expect(res.body.stages.mode).toBe("own");
    expect(res.body.stages.list.map((s: any) => s.name)).toEqual(["Received", "Screening", "Shortlisted", "Selected"]);
    expect(res.body.stages.startIndex).toBe(1);

    const byName = Object.fromEntries(res.body.stages.list.map((s: any) => [s.name, s.id]));
    const after = async (r: any) => (await ResponseModel.findById(r._id).lean()) as any;
    expect(String((await after(rNew)).stageId)).toBe(byName.Received);
    expect(String((await after(rProgress)).stageId)).toBe(byName.Screening);
    expect(String((await after(rDone)).stageId)).toBe(byName.Selected);
    expect((await after(rDone)).status).toBe("completed");
    expect((await after(rNew)).boardRank).toBeUndefined();

    // the workspace's own list is untouched, and the other forms keep using it
    const wsStages = await request(app).get("/api/workspaces/rs-ws/stages").set(headers.owner);
    expect((wsStages.body.stages ?? wsStages.body.data).map((s: any) => s.name)).toEqual(["New", "In Progress", "Completed"]);
    const other = await mkForm();
    expect((await get(other)).body.stages.mode).toBe("workspace");
  });

  it("editing the form's stages: rename, recolour, reorder, change a category and delete one", async () => {
    const f = await mkForm();
    const first = await put(f, body({ stages: { mode: "own", stages: OWN, startIndex: 0 } }));
    const list = first.body.stages.list as any[];
    const id = (name: string) => list.find((s) => s.name === name).id;
    const [a, b, c, d] = ["Received", "Screening", "Shortlisted", "Selected"].map(id);
    await ResponseModel.create([
      { formId: f._id, answers: {}, stageId: b, status: "in_progress" },
      { formId: f._id, answers: {}, stageId: c, status: "in_progress" },
      { formId: f._id, answers: {}, stageId: d, status: "completed" },
    ]);

    // delete Screening, make Selected count as in progress, rename Received, and put Shortlisted first
    const edited = await put(f, body({
      version: 1,
      stages: { mode: "own", startIndex: 1, stages: [
        { id: c, name: "Shortlisted", colour: "sky", category: "in_progress" },
        { id: a, name: "Inbox", colour: "slate", category: "new" },
        { id: d, name: "Selected", colour: "emerald", category: "in_progress" },
      ] },
    }));
    expect(edited.status).toBe(200);
    expect(edited.body.stages.list.map((s: any) => s.name)).toEqual(["Shortlisted", "Inbox", "Selected"]);
    expect(edited.body.stages.startIndex).toBe(1);
    expect(await StageModel.countDocuments({ formId: f._id })).toBe(3);

    const rows = (await ResponseModel.find({ formId: f._id }).setOptions({ includeTest: true }).lean()) as any[];
    // the response that was in the deleted Screening is now in Shortlisted (first stage counting as in progress)
    expect(rows.filter((r) => String(r.stageId) === c)).toHaveLength(2);
    // Selected now counts as in progress, so its response's status follows
    expect(rows.find((r) => String(r.stageId) === d).status).toBe("in_progress");
    expect(await StageModel.findOne({ _id: a }).lean()).toMatchObject({ name: "Inbox" });
  });

  it("going back to the workspace stages moves the responses back and removes the form's stages", async () => {
    const f = await mkForm();
    const [rNew, , rDone] = await seedResponses(f);
    await put(f, body({ stages: { mode: "own", stages: OWN } }));
    expect(await StageModel.countDocuments({ formId: f._id })).toBe(4);
    const back = await put(f, body({ version: 1, stages: { mode: "workspace" } }));
    expect(back.status).toBe(200);
    expect(back.body.stages.mode).toBe("workspace");
    expect(await StageModel.countDocuments({ formId: f._id })).toBe(0);
    const wsDone: any = await StageModel.findOne({ workspaceId: ws._id, formId: null, category: "completed" }).lean();
    expect(String(((await ResponseModel.findById(rDone._id).lean()) as any).stageId)).toBe(String(wsDone._id));
    expect(((await ResponseModel.findById(rNew._id).lean()) as any).status).toBe("new");
  });

  it("a stage from another form, or from the workspace, is refused once the form has its own stages", async () => {
    const f = await mkForm();
    const other = await mkForm();
    await put(other, body({ stages: { mode: "own", stages: OWN } }));
    const first = await put(f, body({ stages: { mode: "own", stages: OWN } }));
    const mine = first.body.stages.list[3].id;
    const theirs = (await get(other)).body.stages.list[0].id;
    const wsStage: any = await StageModel.findOne({ workspaceId: ws._id, formId: null }).lean();
    const [resp] = (await ResponseModel.create([{ formId: f._id, answers: {}, stageId: mine, status: "completed" }])) as any[];
    const move = (stageId: string) => request(app).patch(`/api/responses/${resp._id}`).set(headers.owner).send({ stageId });

    expect((await move(theirs)).status).toBe(400);
    expect((await move(String(wsStage._id))).status).toBe(400);
    expect((await move(first.body.stages.list[1].id)).status).toBe(200);
    // and a form that has NOT customised its stages cannot be moved onto a form's stage
    const plain = await mkForm();
    const [pr] = (await ResponseModel.create([{ formId: plain._id, answers: {}, stageId: wsStage._id, status: wsStage.category }])) as any[];
    expect((await request(app).patch(`/api/responses/${pr._id}`).set(headers.owner).send({ stageId: mine })).status).toBe(400);
  });

  it("a new submission starts in the stage chosen as the start, and the stats count the form's own stages", async () => {
    const f = await mkForm();
    const saved = await put(f, body({ stages: { mode: "own", stages: OWN, startIndex: 2 } }));
    const start = saved.body.stages.list[2];
    const sub = await request(app).post(`/api/public/${f.publishedSlug}/submit`).send({ "f-name": "Asha" });
    expect(sub.status).toBe(200);
    const stored: any = await ResponseModel.findOne({ formId: f._id }).lean();
    expect(String(stored.stageId)).toBe(start.id);
    expect(stored.status).toBe("in_progress");

    const stats = await request(app).get(`/api/responses/stats?formId=${f._id}`).set(headers.owner);
    expect(stats.status).toBe(200);
    expect(stats.body.byStage).toEqual([expect.objectContaining({ stageId: start.id, name: "Shortlisted", count: 1 })]);
  });

  it("a personal form cannot have stages of its own", async () => {
    const f = await mkForm({ workspaceId: null, createdBy: (await User.findOne({ email: "rs-owner@test.com" }))!._id });
    const res = await request(app).put(`/api/forms/${f._id}/response-setup`).set({ ...headers.owner, "x-workspace-slug": "personal" }).send(body({ stages: { mode: "own", stages: OWN } }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PERSONAL_FORM_STAGES");
  });

  it("the workspace's own stage tools never touch a form's stages", async () => {
    const f = await mkForm();
    const saved = await put(f, body({ stages: { mode: "own", stages: OWN } }));
    const formStage = saved.body.stages.list[0].id;
    const del = await request(app).delete(`/api/workspaces/rs-ws/stages/${formStage}`).set(headers.owner).send({});
    expect(del.status).toBe(404);
    const patch = await request(app).patch(`/api/workspaces/rs-ws/stages/${formStage}`).set(headers.owner).send({ name: "Hacked" });
    expect(patch.status).toBe(404);
    expect(await StageModel.countDocuments({ formId: f._id })).toBe(4);
  });
});

describe("copying and removing", () => {
  it("a duplicate of a form starts with the same setup and its own copy of the stages", async () => {
    const f = await mkForm();
    await put(f, body({ tableColumns: ["respondent", "q:f-film"], cardTitle: "f-film", stages: { mode: "own", stages: OWN, startIndex: 3 } }));
    const dup = await request(app).post(`/api/forms/${f._id}/duplicate`).set(headers.owner).send({});
    expect(dup.status).toBeLessThan(300);
    const copyId = dup.body.form?._id ?? dup.body.data?._id ?? dup.body._id;
    const res = await request(app).get(`/api/forms/${copyId}/response-setup`).set(headers.owner);
    expect(res.body.setup.tableColumns).toEqual(["respondent", "q:f-film"]);
    expect(res.body.stages.mode).toBe("own");
    expect(res.body.stages.startIndex).toBe(3);
    const originals = (await get(f)).body.stages.list.map((s: any) => s.id);
    expect(res.body.stages.list.some((s: any) => originals.includes(s.id))).toBe(false); // its own copies, not shared
  });

  it("deleting a form for good removes its setup and its stages", async () => {
    const f = await mkForm();
    await put(f, body({ stages: { mode: "own", stages: OWN } }));
    await deleteFormData(String(f._id));
    expect(await ResponseSetup.countDocuments({ formId: f._id })).toBe(0);
    expect(await StageModel.countDocuments({ formId: f._id })).toBe(0);
  });
});
