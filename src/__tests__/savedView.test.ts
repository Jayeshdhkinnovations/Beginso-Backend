import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { generateToken } from "../utils/generateToken";

let mongoServer: MongoMemoryServer;

describe("Saved views (BE 0.4)", () => {
  let ownerToken: string;
  let adminToken: string;
  let reviewerToken: string;
  let outsiderToken: string;
  let workspaceId: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = "testsecret";
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const owner = await User.create({ firebaseUid: "sv-owner", fullName: "Owner", email: "sv-owner@test.com", role: "admin" });
    const admin = await User.create({ firebaseUid: "sv-admin", fullName: "Admin", email: "sv-admin@test.com", role: "admin" });
    const reviewer = await User.create({ firebaseUid: "sv-reviewer", fullName: "Reviewer", email: "sv-reviewer@test.com", role: "admin" });
    const outsider = await User.create({ firebaseUid: "sv-outsider", fullName: "Outsider", email: "sv-outsider@test.com", role: "admin" });

    const ws = await Workspace.create({ name: "SV Workspace", owner: owner._id });
    workspaceId = ws.slug;
    await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
    await Membership.create({ userId: admin._id, workspaceId: ws._id, role: "admin" });
    await Membership.create({ userId: reviewer._id, workspaceId: ws._id, role: "reviewer" });

    ownerToken = generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role });
    adminToken = generateToken({ id: admin._id.toString(), email: admin.email, role: admin.role });
    reviewerToken = generateToken({ id: reviewer._id.toString(), email: reviewer.email, role: reviewer.role });
    outsiderToken = generateToken({ id: outsider._id.toString(), email: outsider.email, role: outsider.role });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it("a reviewer can create a personal view but not a team view", async () => {
    const personal = await request(app)
      .post("/api/views")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .set("x-workspace-slug", workspaceId)
      .send({ name: "My shortlist", visibility: "personal", filters: { unread: true }, viewMode: "table" });
    expect(personal.status).toBe(201);

    const team = await request(app)
      .post("/api/views")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .set("x-workspace-slug", workspaceId)
      .send({ name: "Needs screening", visibility: "team", filters: {}, viewMode: "table" });
    expect(team.status).toBe(403);
  });

  it("owner can create a team view; reviewer sees it but outsider (no membership) sees nothing", async () => {
    const created = await request(app)
      .post("/api/views")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-workspace-slug", workspaceId)
      .send({ name: "Needs screening", visibility: "team", filters: { stageId: "abc" }, viewMode: "board" });
    expect(created.status).toBe(201);

    const reviewerList = await request(app)
      .get("/api/views")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .set("x-workspace-slug", workspaceId);
    expect(reviewerList.status).toBe(200);
    expect(reviewerList.body.views.some((v: any) => v.name === "Needs screening")).toBe(true);

    const outsiderList = await request(app)
      .get("/api/views")
      .set("Authorization", `Bearer ${outsiderToken}`)
      .set("x-workspace-slug", workspaceId);
    expect(outsiderList.status).toBe(403);
  });

  it("a personal view is never returned to another member", async () => {
    const mine = await request(app)
      .post("/api/views")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-workspace-slug", workspaceId)
      .send({ name: "Admin's private view", visibility: "personal", filters: {}, viewMode: "table" });
    expect(mine.status).toBe(201);

    const reviewerList = await request(app)
      .get("/api/views")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .set("x-workspace-slug", workspaceId);
    expect(reviewerList.body.views.some((v: any) => v.name === "Admin's private view")).toBe(false);
  });

  it("only the owner, or Admin+ for a team view, may rename/delete; a reviewer cannot delete someone else's team view", async () => {
    const created = await request(app)
      .post("/api/views")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-workspace-slug", workspaceId)
      .send({ name: "Deletable team view", visibility: "team", filters: {}, viewMode: "table" });
    const id = created.body.view.id;

    const reviewerDelete = await request(app)
      .delete(`/api/views/${id}`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .set("x-workspace-slug", workspaceId);
    expect(reviewerDelete.status).toBe(403);

    const adminDelete = await request(app)
      .delete(`/api/views/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-workspace-slug", workspaceId);
    expect(adminDelete.status).toBe(204);
  });

  it("a saved view stores filters, never results — visibility never widens what a member can see", async () => {
    // Regression for requirements.md §7.6 / design.md §11.1's explicit guarantee: creating or
    // reading a team view must never itself return response data, only the filter object.
    const created = await request(app)
      .post("/api/views")
      .set("Authorization", `Bearer ${ownerToken}`)
      .set("x-workspace-slug", workspaceId)
      .send({ name: "Filters only", visibility: "team", filters: { stageId: "xyz", unread: true }, viewMode: "table" });

    expect(created.body.view.filters).toEqual({ stageId: "xyz", unread: true });
    expect(created.body.view).not.toHaveProperty("responses");
    expect(created.body.view).not.toHaveProperty("data");
  });
});
