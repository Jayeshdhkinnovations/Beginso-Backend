// QA A9-004: a per-form "Reviewer" grant silently took edit rights away from a workspace Editor on that form, because the
// grant's smaller role was checked instead of their own. A grant only ever ADDS access.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import FormAccessGrant from "../models/FormAccessGrant";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-grant-never-lowers";

let mongoServer: MongoMemoryServer;
let owner: any;
let editor: any;
let reviewer: any;
let outsider: any;
let ws: any;
let form: any;

const as = (u: any) => ({ Authorization: `Bearer ${generateToken({ id: u._id.toString(), email: u.email, role: u.role })}`, "x-workspace-id": ws._id.toString() });
const edit = (u: any, title = "Edited") => request(app).patch(`/api/forms/${form._id}`).set(as(u)).send({ title });
const read = (u: any) => request(app).get(`/api/forms/${form._id}`).set(as(u));
const grant = (u: any, role: string) => FormAccessGrant.create({ formId: form._id, userId: u._id, role: role as any, grantedBy: owner._id });
const mk = (n: string) => User.create({ firebaseUid: `uid-gnl-${n}`, fullName: n, email: `gnl-${n}@test.com`, role: "admin", status: "active" });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  [owner, editor, reviewer, outsider] = await Promise.all([mk("owner"), mk("editor"), mk("reviewer"), mk("outsider")]);
  ws = await Workspace.create({ name: "GNL", slug: "gnl", timezone: "UTC", owner: owner._id });
  await Membership.create([
    { userId: owner._id, workspaceId: ws._id, role: "owner" },
    { userId: editor._id, workspaceId: ws._id, role: "editor" },
    { userId: reviewer._id, workspaceId: ws._id, role: "reviewer" },
  ]);
  form = await Form.create({ title: "Shared", workspaceId: ws._id, createdBy: owner._id, fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }] });
});
beforeEach(() => FormAccessGrant.deleteMany({}));
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("a per-form grant never lowers what a workspace role already allows", () => {
  it("baseline: an Editor can edit, a Reviewer cannot", async () => {
    expect((await edit(editor)).status).toBe(200);
    expect((await edit(reviewer)).status).toBe(403);
  });

  it("an Editor given a Reviewer grant on the form can STILL edit it (the reported bug)", async () => {
    await grant(editor, "reviewer");
    expect((await edit(editor, "Still mine")).status).toBe(200);
    expect((await Form.findById(form._id).lean())!.title).toBe("Still mine");
    expect((await read(editor)).status).toBe(200);
  });

  it("a Reviewer given an Editor grant on the form CAN edit it: a grant still adds access", async () => {
    expect((await edit(reviewer)).status).toBe(403);
    await grant(reviewer, "editor");
    expect((await edit(reviewer, "By reviewer")).status).toBe(200);
  });

  it("a Reviewer given only a Reviewer grant still cannot edit", async () => {
    await grant(reviewer, "reviewer");
    expect((await edit(reviewer)).status).toBe(403);
    expect((await read(reviewer)).status).toBe(200);
  });

  it("someone outside the workspace with a Reviewer grant can read the form but not edit it", async () => {
    await grant(outsider, "reviewer");
    expect((await read(outsider)).status).toBe(200);
    expect((await edit(outsider)).status).toBe(403);
  });

  it("someone outside the workspace with no grant gets nothing", async () => {
    expect([403, 404]).toContain((await read(outsider)).status);
  });
});
