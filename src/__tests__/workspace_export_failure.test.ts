// A workspace data export that fails, or is lost, says "failed" instead of staying "processing" for ever.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-workspace-export-failure";

let mongoServer: MongoMemoryServer;
let owner: any;
let ws: any;

const auth = () => ({ Authorization: `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role })}`, "x-workspace-id": ws._id.toString() });
const statusOf = async (jobId: string) =>
  (await request(app).get("/api/workspaces/current/export/status").query({ jobId }).set(auth())).body.exportJob.status;

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  owner = await User.create({ firebaseUid: "uid-export-owner", fullName: "Export Owner", email: "export-owner@test.com", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "Export WS", slug: "export-ws", timezone: "UTC", owner: owner._id });
  owner.workspaceId = ws._id;
  await owner.save();
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
});

afterAll(async () => {
  jest.restoreAllMocks();
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("a workspace export that cannot be built", () => {
  it("is reported as failed, and its download says so", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const find = jest.spyOn(Form, "find").mockImplementationOnce(() => {
      throw new Error("database went away");
    });
    const start = await request(app).post("/api/workspaces/current/export").set(auth());
    const jobId = start.body.exportJob.id;
    let status = "processing";
    for (let i = 0; i < 40 && status === "processing"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await statusOf(jobId);
    }
    find.mockRestore();
    expect(status).toBe("failed");
    const file = await request(app).get("/api/workspaces/current/export/file").query({ jobId }).set(auth());
    expect(file.status).toBe(410);
  });

  it("an export lost long ago is failed; one just started is still processing", async () => {
    const old = mongoose.Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 3600).toString();
    expect(await statusOf(old)).toBe("failed");
    expect(await statusOf(new mongoose.Types.ObjectId().toString())).toBe("processing");
  });
});
