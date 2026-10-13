// Deleting a form or a workspace must not leave its related rows behind: notes, scores, read state, respondent links,
// reference counters and saved views of a purged form; stages, tags, score criteria, saved views and charts, workspace
// templates and the shared Home layout of a deleted workspace. Another workspace's rows must be untouched.
process.env.JWT_SECRET = "test-jwt-secret-key-for-cleanup-related-data";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Note from "../models/Note";
import ScoreEntry from "../models/ScoreEntry";
import ResponseReadState from "../models/ResponseReadState";
import RespondentLink from "../models/RespondentLink";
import FormReferenceCounter from "../models/FormReferenceCounter";
import Stage from "../models/Stage";
import Tag from "../models/Tag";
import ScoreCriterion from "../models/ScoreCriterion";
import SavedView from "../models/SavedView";
import SavedChart from "../models/SavedChart";
import Template from "../models/Template";
import Dashboard from "../models/Dashboard";
import { deleteFormData, deleteWorkspaceData } from "../services/cleanup.service";

let mongoServer: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();

// Rows are written straight to the collection: only the keys the cleanup looks at matter here.
const raw = (M: any, doc: Record<string, unknown>) => M.collection.insertOne({ createdAt: new Date(), updatedAt: new Date(), ...doc });
const count = (M: any, filter: Record<string, unknown>) => M.countDocuments(filter);

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const seedForm = async (workspaceId: mongoose.Types.ObjectId | null) => {
  const owner = oid();
  const formId = oid();
  const responseId = oid();
  await raw(Form, { _id: formId, title: "F", workspaceId, createdBy: owner, status: "draft", fields: [], pages: [] });
  await raw(ResponseModel, { _id: responseId, formId, answers: {}, status: "new" });
  await raw(Note, { responseId, authorId: owner, body: "n" });
  await raw(ScoreEntry, { responseId, criterionId: oid(), reviewerId: owner, score: 3 });
  await raw(ResponseReadState, { responseId, userId: owner });
  await raw(RespondentLink, { responseId, formId, email: "a@b.test", tokenHash: "h" + responseId, expiresAt: new Date(Date.now() + 1e9) });
  await raw(FormReferenceCounter, { formId, seq: 5 });
  await raw(SavedView, { formId, ownerId: owner, workspaceId, name: "v" });
  await raw(SavedChart, { formId, workspaceId, ownerId: owner, createdBy: owner });
  return { formId, responseId };
};

describe("deleteFormData", () => {
  it("removes the notes, scores, read state, respondent links, counter and saved views of the form's responses", async () => {
    const a = await seedForm(oid());
    const b = await seedForm(oid());
    await deleteFormData(String(a.formId));

    expect(await count(ResponseModel, { formId: a.formId })).toBe(0);
    for (const M of [Note, ScoreEntry, ResponseReadState, RespondentLink] as any[]) expect(await count(M, { responseId: a.responseId })).toBe(0);
    expect(await count(RespondentLink, { formId: a.formId })).toBe(0);
    expect(await count(FormReferenceCounter, { formId: a.formId })).toBe(0);
    expect(await count(SavedView, { formId: a.formId })).toBe(0);
    expect(await count(SavedChart, { formId: a.formId })).toBe(0);

    // the other form is untouched
    expect(await count(ResponseModel, { formId: b.formId })).toBe(1);
    for (const M of [Note, ScoreEntry, ResponseReadState, RespondentLink] as any[]) expect(await count(M, { responseId: b.responseId })).toBe(1);
    expect(await count(FormReferenceCounter, { formId: b.formId })).toBe(1);
  });
});

describe("deleteWorkspaceData", () => {
  it("removes the workspace's configuration, templates and shared Home layout, and only its own", async () => {
    const ws = await Workspace.create({ name: "Cleanup A", owner: oid() });
    const other = await Workspace.create({ name: "Cleanup B", owner: oid() });
    const mine = ws._id as mongoose.Types.ObjectId;
    const theirs = other._id as mongoose.Types.ObjectId;

    for (const wsId of [mine, theirs]) {
      await raw(Stage, { workspaceId: wsId, name: "s", order: 0, category: "new" });
      await raw(Tag, { workspaceId: wsId, name: "t", nameLower: "t" });
      await raw(ScoreCriterion, { workspaceId: wsId, label: "c", order: 0 });
      await raw(SavedView, { workspaceId: wsId, ownerId: oid(), name: "v" });
      await raw(SavedChart, { workspaceId: wsId, ownerId: oid(), createdBy: oid() });
      await raw(Template, { workspaceId: wsId, name: "own template", category: "x", isActive: true, fields: [] });
      await raw(Dashboard, { workspaceId: wsId, ownerId: oid(), kind: "home", widgets: [], version: 1 });
    }
    // a built-in template (no workspace) must never be touched by a workspace deletion
    await raw(Template, { workspaceId: null, name: "built-in", category: "x", isActive: true, fields: [] });
    const form = await seedForm(mine);

    await deleteWorkspaceData(mine);

    for (const M of [Stage, Tag, ScoreCriterion, SavedView, SavedChart, Template, Dashboard] as any[]) {
      expect(await count(M, { workspaceId: mine })).toBe(0);
      expect(await count(M, { workspaceId: theirs })).toBe(1);
    }
    expect(await count(Template, { workspaceId: null, name: "built-in" })).toBe(1);
    expect(await count(Note, { responseId: form.responseId })).toBe(0);
    expect(await count(Workspace, { _id: mine })).toBe(0);
    expect(await count(Workspace, { _id: theirs })).toBe(1);
  });
});
