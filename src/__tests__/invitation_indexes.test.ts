// QA A9-001: a stale NON-sparse unique index on invitations.token made every second invitation answer 409
// "already pending". The controller must not blame the user for a foreign duplicate key, and the migration
// must repair the index.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Invitation from "../models/Invitation";
import { mailService } from "../services/mail.service";
import { generateToken } from "../utils/generateToken";
import { migrateInvitationIndexes, staleInvitationIndexes } from "../scripts/migrateInvitationIndexes";

process.env.JWT_SECRET = "test-jwt-secret-key-for-invitation-indexes";

let mongoServer: MongoMemoryServer;
let owner: any;
let wsA: any;
let wsB: any;

const invite = (ws: any, email: string) =>
  request(app)
    .post(`/api/workspaces/${ws._id}/invitations`)
    .set("Authorization", `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: owner.role })}`)
    .send({ email, role: "editor" });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Invitation.init();
  jest.spyOn(mailService, "sendMail").mockResolvedValue(undefined as any);
  jest.spyOn(console, "error").mockImplementation(() => {});

  owner = await User.create({ firebaseUid: "uid-inv-owner", fullName: "Inv Owner", email: "inv-owner@test.com", role: "admin", status: "active" });
  wsA = await Workspace.create({ name: "Inv A", slug: "inv-a", timezone: "UTC", owner: owner._id });
  wsB = await Workspace.create({ name: "Inv B", slug: "inv-b", timezone: "UTC", owner: owner._id });
  owner.workspaceId = wsA._id;
  await owner.save();
  await Membership.create([
    { userId: owner._id, workspaceId: wsA._id, role: "owner" },
    { userId: owner._id, workspaceId: wsB._id, role: "owner" },
  ]);
});

afterAll(async () => {
  jest.restoreAllMocks();
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("invitation index repair (A9-001)", () => {
  it("a healthy database has no stale indexes and the dry run changes nothing", async () => {
    expect(await staleInvitationIndexes()).toEqual([]);
    expect(await migrateInvitationIndexes({ dryRun: true })).toEqual({ stale: [], dropped: [] });
  });

  it("with the legacy non-sparse token index, the second invite is a 500, never a fake 'already pending'", async () => {
    await Invitation.collection.dropIndex("token_1");
    await Invitation.collection.createIndex({ token: 1 }, { unique: true, name: "token_1" }); // the broken shape
    expect(await staleInvitationIndexes()).toEqual(["token_1"]);

    expect((await invite(wsA, "one@example.com")).status).toBe(201);
    const second = await invite(wsA, "two@example.com");
    expect(second.status).toBe(500);
    expect(second.body?.error?.code).not.toBe("INVITATION_ALREADY_PENDING");
  });

  it("the migration repairs it: three emails into one workspace, another workspace, and re-invite after revoke all succeed", async () => {
    await Invitation.deleteMany({});
    expect(await migrateInvitationIndexes({ dryRun: true })).toEqual({ stale: ["token_1"], dropped: [] });
    expect(await migrateInvitationIndexes()).toEqual({ stale: ["token_1"], dropped: ["token_1"] });
    expect(await staleInvitationIndexes()).toEqual([]);
    expect(await migrateInvitationIndexes()).toEqual({ stale: [], dropped: [] }); // idempotent

    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      expect((await invite(wsA, email)).status).toBe(201);
    }
    expect((await invite(wsB, "a@example.com")).status).toBe(201);

    const first = await Invitation.findOne({ workspaceId: wsA._id, email: "a@example.com" });
    await Invitation.updateOne({ _id: first!._id }, { $set: { status: "revoked" } });
    expect((await invite(wsA, "a@example.com")).status).toBe(201);
  });

  it("re-sending to an email that is still pending keeps ONE pending invitation (no duplicate row)", async () => {
    await invite(wsA, "again@example.com");
    const again = await invite(wsA, "again@example.com");
    expect([200, 201]).toContain(again.status);
    expect(await Invitation.countDocuments({ workspaceId: wsA._id, email: "again@example.com", status: "pending" })).toBe(1);
  });

  it("a genuine race on the pending index is still reported as 409 INVITATION_ALREADY_PENDING", async () => {
    const spy = jest.spyOn(Invitation, "create").mockRejectedValueOnce(
      Object.assign(new Error("E11000"), { code: 11000, keyPattern: { workspaceId: 1, email: 1 }, keyValue: { email: "race@example.com" } }) as never
    );
    const res = await invite(wsA, "race@example.com");
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVITATION_ALREADY_PENDING");
  });
});
