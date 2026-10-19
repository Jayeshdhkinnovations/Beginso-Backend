// QA D8-010: the audit log named response events by the last six characters of the response id ("response bulk tag #92E525"), because
// the events were written with the raw id as their label. logWorkspaceEvent now resolves it to the reference people see (#49).
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { logWorkspaceEvent, eventTargetLabel } from "../services/event.service";
import { Event } from "../models/Event";
import ResponseModel from "../models/Response";

let mongo: MongoMemoryServer;
const workspaceId = new mongoose.Types.ObjectId();
const actor = { id: new mongoose.Types.ObjectId(), email: "a@x.com", name: "Asha" };

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const labelOf = async (targetId: string) => (await Event.findOne({ targetId }).lean())?.targetLabel;

describe("audit event labels", () => {
  it("a response event labelled with its raw id is stored with the response's reference", async () => {
    const r: any = await ResponseModel.create({ formId: new mongoose.Types.ObjectId(), answers: {}, status: "new", reference: "#49" });
    const id = String(r._id);
    await logWorkspaceEvent({ workspaceId, actor, action: "response.bulk_tag", targetId: id, targetType: "response", targetLabel: id });
    expect(await labelOf(id)).toBe("#49");
  });

  it("a response with no reference falls back to the last six characters of its id, upper-cased, with a #", async () => {
    const r: any = await ResponseModel.create({ formId: new mongoose.Types.ObjectId(), answers: {}, status: "new" });
    await ResponseModel.updateOne({ _id: r._id }, { $unset: { reference: "" } });
    const id = String(r._id);
    await logWorkspaceEvent({ workspaceId, actor, action: "response.note_add", targetId: id, targetType: "response", targetLabel: id });
    expect(await labelOf(id)).toBe(`#${id.slice(-6).toUpperCase()}`);
  });

  it("an id for a response that no longer exists still gets the short form, and never throws", async () => {
    const gone = String(new mongoose.Types.ObjectId());
    await expect(eventTargetLabel("response", gone, gone)).resolves.toBe(`#${gone.slice(-6).toUpperCase()}`);
  });

  it("labels that are already readable, and events about other things, are left alone", async () => {
    expect(await eventTargetLabel("response", "x", "#12")).toBe("#12");
    const formId = String(new mongoose.Types.ObjectId());
    expect(await eventTargetLabel("form", formId, formId)).toBe(formId);
    expect(await eventTargetLabel("tag", "t1", "Urgent")).toBe("Urgent");
  });
});
