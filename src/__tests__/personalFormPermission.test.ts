import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;

/**
 * Real bug found in production (30 Sep 2026): publishing/closing a genuinely personal form
 * (`Form.workspaceId: null`) 403'd with "Forbidden: Insufficient permissions" whenever the
 * caller also happened to be a member of some workspace with a role below Owner/Admin there.
 * Root cause: `permission.middleware.ts`'s resource-based resolution for a `form`/`response`
 * only set `targetWorkspaceId` when the resource *had* a workspace — leaving it unset for a
 * personal resource, which then fell through to "caller's default workspace" and checked the
 * *wrong* workspace's role instead of recognising the resource has none at all.
 */
describe("A personal form's own routes never fall back to the caller's unrelated workspace role", () => {
  let userToken: string;
  let personalFormId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = "testsecret";
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const user = await User.create({
      firebaseUid: "personal-form-user-uid",
      fullName: "Personal Form User",
      email: "personalform@test.com",
      role: "admin",
    });
    userToken = generateToken({ id: user._id.toString(), email: user.email, role: user.role });

    // The user is also a Reviewer (below Owner/Admin, no forms:publish) in some unrelated
    // workspace they don't own — this is what the fallback used to wrongly check against.
    const otherOwner = await User.create({
      firebaseUid: "other-owner-uid",
      fullName: "Other Owner",
      email: "otherowner@test.com",
      role: "admin",
    });
    const otherWorkspace = await Workspace.create({ name: "Unrelated Workspace", owner: otherOwner._id });
    await Membership.create({ userId: user._id, workspaceId: otherWorkspace._id, role: "reviewer" });

    const personalForm = await Form.create({
      title: "My personal form",
      createdBy: user._id,
      workspaceId: null,
      fields: [{ id: "f1", label: "Name", type: "short_text", order: 0 }],
      status: "draft",
    });
    personalFormId = personalForm._id.toString();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it("publishes a personal form even though the caller is only a Reviewer elsewhere", async () => {
    const res = await request(app)
      .post(`/api/forms/${personalFormId}/publish`)
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("closes a personal form even though the caller is only a Reviewer elsewhere", async () => {
    const res = await request(app)
      .post(`/api/forms/${personalFormId}/close`)
      .set("Authorization", `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
