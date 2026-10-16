// PATCH/GET /api/workspaces/current must persist and return description + timezone (QA A8-001: they were
// silently stripped by the Zod schema, so the UI saved "successfully" and reloaded empty/UTC).
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { generateToken } from "../utils/generateToken";

process.env.JWT_SECRET = "test-jwt-secret-key-for-workspace-settings-fields";

let mongoServer: MongoMemoryServer;
let owner: any;
let ws: any;

const as = (r: request.Test) =>
  r
    .set("Authorization", `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role })}`)
    .set("x-workspace-id", ws._id.toString());

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  owner = await User.create({ firebaseUid: "uid-wsf-owner", fullName: "WSF Owner", email: "wsf-owner@test.com", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "WSF", slug: "wsf-one", timezone: "UTC", owner: owner._id });
  owner.workspaceId = ws._id;
  await owner.save();
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("workspace settings: description and timezone", () => {
  it("saves both, returns them from PATCH, and still has them on a later GET", async () => {
    const patch = await as(request(app).patch("/api/workspaces/current").send({ description: "Our team", timezone: "Asia/Kolkata" }));
    expect(patch.status).toBe(200);
    expect(patch.body.workspace.description).toBe("Our team");
    expect(patch.body.workspace.timezone).toBe("Asia/Kolkata");

    const get = await as(request(app).get("/api/workspaces/current"));
    expect(get.body.workspace.description).toBe("Our team");
    expect(get.body.workspace.timezone).toBe("Asia/Kolkata");
  });

  it("an update that sends neither leaves them alone, and null clears the description", async () => {
    await as(request(app).patch("/api/workspaces/current").send({ name: "WSF renamed" }));
    const kept = await as(request(app).get("/api/workspaces/current"));
    expect(kept.body.workspace.timezone).toBe("Asia/Kolkata");
    expect(kept.body.workspace.description).toBe("Our team");

    const cleared = await as(request(app).patch("/api/workspaces/current").send({ description: null }));
    expect(cleared.body.workspace.description).toBe("");
  });

  it("rejects an invalid timezone with 400 instead of pretending to save", async () => {
    const res = await as(request(app).patch("/api/workspaces/current").send({ timezone: "Not/AZone" }));
    expect(res.status).toBe(400);
  });
});
