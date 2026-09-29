import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import StageModel from "../models/Stage";
import { migrateStagesFromStatus } from "../scripts/migrateStagesFromStatus";

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe("migrateStagesFromStatus", () => {
  it("seeds default stages, maps every response's status onto the matching stage, and the per-status/per-stage counts agree", async () => {
    const ws1 = await Workspace.create({ name: "Migrate WS 1", owner: new mongoose.Types.ObjectId() });
    const ws2 = await Workspace.create({ name: "Migrate WS 2", owner: new mongoose.Types.ObjectId() });

    const form1 = await Form.create({ title: "F1", workspaceId: ws1._id, status: "published", publishedSlug: "m-f1", fields: [] });
    const form2 = await Form.create({ title: "F2", workspaceId: ws2._id, status: "published", publishedSlug: "m-f2", fields: [] });

    await ResponseModel.create({ formId: form1._id, answers: {}, status: "new" });
    await ResponseModel.create({ formId: form1._id, answers: {}, status: "in_progress" });
    await ResponseModel.create({ formId: form1._id, answers: {}, status: "completed" });
    await ResponseModel.create({ formId: form2._id, answers: {}, status: "completed" });
    await ResponseModel.create({ formId: form2._id, answers: {}, status: "completed" });

    const result = await migrateStagesFromStatus();

    expect(result.workspacesSeeded).toBe(2);
    expect(result.responsesMigrated).toBe(5);

    const stagesWs1 = await StageModel.find({ workspaceId: ws1._id });
    const stagesWs2 = await StageModel.find({ workspaceId: ws2._id });
    expect(stagesWs1.length).toBe(3);
    expect(stagesWs2.length).toBe(3);

    // Every response now has a stageId whose stage.category matches its original status.
    const responses = await ResponseModel.find({ formId: { $in: [form1._id, form2._id] } }).populate("stageId");
    for (const r of responses) {
      expect(r.stageId).toBeTruthy();
      const stage: any = r.stageId;
      expect(stage.category).toBe(r.status);
    }

    // Idempotent: re-running migrates nothing further and does not throw.
    const second = await migrateStagesFromStatus();
    expect(second.workspacesSeeded).toBe(0);
    expect(second.responsesMigrated).toBe(0);
  });

  it("throws instead of reporting success when per-status and per-stage-category counts disagree", async () => {
    const ws = await Workspace.create({ name: "Bad Migrate WS", owner: new mongoose.Types.ObjectId() });
    const form = await Form.create({ title: "BadForm", workspaceId: ws._id, status: "published", publishedSlug: "bad-f", fields: [] });
    const resp = await ResponseModel.create({ formId: form._id, answers: {}, status: "completed" });

    // Simulate a migration that already ran but landed the response on the wrong category
    // (e.g. a bug), so the before/after assertion must catch it rather than silently reporting ok.
    const seeded = await StageModel.insertMany([
      { workspaceId: ws._id, name: "New", colour: "slate", category: "new", isDefault: true, order: 0 },
      { workspaceId: ws._id, name: "In Progress", colour: "amber", category: "in_progress", isDefault: false, order: 1 },
      { workspaceId: ws._id, name: "Completed", colour: "emerald", category: "completed", isDefault: false, order: 2 },
    ]);
    const wrongStage = seeded.find((s: any) => s.category === "new")!;
    await ResponseModel.updateOne({ _id: resp._id }, { $set: { stageId: wrongStage._id } });

    await expect(migrateStagesFromStatus()).rejects.toThrow(/count mismatch/);
  });
});
