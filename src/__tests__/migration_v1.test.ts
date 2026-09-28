// V1 -> memberships migration (Sprint 10 BE 0.8 / 0.9): safe by default, precise rollback.
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import Invitation from "../models/Invitation";
import { runV1Migration } from "../scripts/migrateV1ToMemberships";

let mongoServer: MongoMemoryServer;

const mkUser = (key: string) =>
  User.create({ firebaseUid: `uid-mig-${key}`, fullName: `User ${key}`, email: `${key}@mig.test`, role: "admin", status: "active" });
const mkForm = (createdBy: any, extra: any = {}) => Form.create({ title: `form ${Math.random()}`, createdBy, fields: [], ...extra });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User, Workspace, Membership, Form, Invitation].map((m: any) => m.init()));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([User, Workspace, Membership, Form, Invitation].map((m: any) => m.deleteMany({})));
});

describe("default mode (spec: workspaces are created lazily)", () => {
  it("creates no workspace for a user who has none and leaves their personal forms alone", async () => {
    const user = await mkUser("lazy");
    const form = await mkForm(user._id);
    const res = await runV1Migration();
    expect(res.success).toBe(true);
    expect(res.workspacesCreated).toBe(0);
    expect(await Workspace.countDocuments()).toBe(0);
    expect((await Form.findById(form._id))?.workspaceId ?? null).toBeNull();
  });

  it("gives the owner of an existing workspace the Membership row it lacks, once", async () => {
    const owner = await mkUser("owner");
    const ws = await Workspace.create({ name: "Legacy", slug: "legacy-ws", owner: owner._id });
    expect(await Membership.countDocuments({ workspaceId: ws._id })).toBe(0);

    const first = await runV1Migration();
    expect(first.membershipsBackfilled).toBe(1);
    const m = await Membership.findOne({ workspaceId: ws._id, userId: owner._id });
    expect(m?.role).toBe("owner");

    const second = await runV1Migration();
    expect(second.membershipsBackfilled).toBe(0);
    expect(await Membership.countDocuments({ workspaceId: ws._id })).toBe(1);
  });

  it("dry-run reports the backfill and writes nothing", async () => {
    const owner = await mkUser("dry");
    const ws = await Workspace.create({ name: "Dry", slug: "dry-ws", owner: owner._id });
    const res = await runV1Migration({ dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.membershipsBackfilled).toBe(1);
    expect(await Membership.countDocuments({ workspaceId: ws._id })).toBe(0);
  });
});

describe("createWorkspaces option (legacy behaviour)", () => {
  it("creates a workspace per workspace-less user, links their forms, and records exactly which", async () => {
    const user = await mkUser("legacy");
    const f1 = await mkForm(user._id);
    const f2 = await mkForm(user._id);
    const res = await runV1Migration({ createWorkspaces: true });
    expect(res.workspacesCreated).toBe(1);
    expect(res.formsUpdated).toBe(2);

    const ws = await Workspace.findOne({ owner: user._id });
    expect(ws?.metadata?.migratedFromV1).toBe(true);
    expect([...ws!.metadata!.migratedFormIds].sort()).toEqual([f1._id.toString(), f2._id.toString()].sort());
    expect((await User.findById(user._id))?.workspaceId?.toString()).toBe(ws!._id.toString());
    expect((await Form.findById(f1._id))?.workspaceId?.toString()).toBe(ws!._id.toString());
  });

  it("is idempotent", async () => {
    await mkUser("idem");
    await runV1Migration({ createWorkspaces: true });
    const again = await runV1Migration({ createWorkspaces: true });
    expect(again.workspacesCreated).toBe(0);
    expect(await Workspace.countDocuments()).toBe(1);
  });

  it("one failing user does not stop the others, and leaves the failed user re-processable", async () => {
    const bad = await mkUser("bad");
    const good = await mkUser("good");
    const badForm = await mkForm(bad._id);
    const original = Membership.create.bind(Membership);
    const spy = jest.spyOn(Membership, "create").mockImplementation(((doc: any) => {
      if (String(doc.userId) === String(bad._id)) return Promise.reject(new Error("boom"));
      return original(doc);
    }) as any);

    const res = await runV1Migration({ createWorkspaces: true });
    spy.mockRestore();

    expect(res.success).toBe(false);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain("bad@mig.test");
    expect(await Workspace.countDocuments({ owner: good._id })).toBe(1);
    expect(await Workspace.countDocuments({ owner: bad._id })).toBe(0);
    expect((await Form.findById(badForm._id))?.workspaceId ?? null).toBeNull();

    const retry = await runV1Migration({ createWorkspaces: true });
    expect(retry.success).toBe(true);
    expect(await Workspace.countDocuments({ owner: bad._id })).toBe(1);
  });
});

describe("rollback", () => {
  it("undoes exactly what the migration did, and the migration can then run again", async () => {
    const user = await mkUser("rb");
    const form = await mkForm(user._id);
    await runV1Migration({ createWorkspaces: true });

    const rb = await runV1Migration({ rollback: true });
    expect(rb.workspacesRolledBack).toBe(1);
    expect(rb.rollbacksSkipped).toBe(0);
    expect(await Workspace.countDocuments()).toBe(0);
    expect(await Membership.countDocuments()).toBe(0);
    expect((await Form.findById(form._id))?.workspaceId ?? null).toBeNull();
    // the user no longer points at a deleted workspace
    expect((await User.findById(user._id))?.workspaceId ?? null).toBeNull();

    const again = await runV1Migration({ createWorkspaces: true });
    expect(again.workspacesCreated).toBe(1);
  });

  it("dry-run changes nothing", async () => {
    await mkUser("rbdry");
    await runV1Migration({ createWorkspaces: true });
    const res = await runV1Migration({ rollback: true, dryRun: true });
    expect(res.workspacesRolledBack).toBe(1);
    expect(await Workspace.countDocuments()).toBe(1);
    expect(await Membership.countDocuments()).toBe(1);
  });

  it("refuses to roll back a workspace that gained a member, a form or an invitation", async () => {
    const user = await mkUser("busy");
    await runV1Migration({ createWorkspaces: true });
    const later = await mkUser("later"); // joins after the migration, so has no migrated workspace of their own
    const ws = (await Workspace.findOne({ owner: user._id }))!;

    await Membership.create({ userId: later._id, workspaceId: ws._id, role: "editor" });
    await mkForm(user._id, { workspaceId: ws._id });
    await Invitation.create({ workspaceId: ws._id, email: "x@mig.test", role: "viewer", status: "pending", token: "tok-busy", expiresAt: new Date(Date.now() + 86400000), invitedBy: user._id });

    const rb = await runV1Migration({ rollback: true });
    expect(rb.rollbacksSkipped).toBe(1);
    expect(rb.workspacesRolledBack).toBe(0);
    expect(rb.details.join(" ")).toMatch(/SKIPPED/);
    expect(await Workspace.countDocuments({ _id: ws._id })).toBe(1);
    expect(await Membership.countDocuments({ workspaceId: ws._id })).toBe(2);
  });

  it("--force rolls it back anyway and leaves nothing pointing at the deleted workspace", async () => {
    const user = await mkUser("force");
    await runV1Migration({ createWorkspaces: true });
    const ws = (await Workspace.findOne({ owner: user._id }))!;
    const extra = await mkForm(user._id, { workspaceId: ws._id });

    const rb = await runV1Migration({ rollback: true, force: true });
    expect(rb.workspacesRolledBack).toBe(1);
    expect((await Form.findById(extra._id))?.workspaceId ?? null).toBeNull();
    expect(await Workspace.countDocuments()).toBe(0);
  });

  it("works on workspaces migrated before the form list was recorded (production data)", async () => {
    const owner = await mkUser("prod");
    const migratedAt = new Date("2026-09-22T10:00:00Z");
    const ws = await Workspace.create({ name: "Prod", slug: "prod-ws", owner: owner._id, metadata: { migratedFromV1: true, migratedAt } });
    await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
    await User.updateOne({ _id: owner._id }, { $set: { workspaceId: ws._id } });
    // createdAt is immutable in Mongoose, so the "existed before the migration" form is created with it
    const before = await mkForm(owner._id, { workspaceId: ws._id, createdAt: new Date("2026-09-01T00:00:00Z") });

    const rb = await runV1Migration({ rollback: true });
    expect(rb.workspacesRolledBack).toBe(1);
    expect((await Form.findById(before._id))?.workspaceId ?? null).toBeNull();

    // a form created after the migration blocks the same rollback
    const ws2 = await Workspace.create({ name: "Prod2", slug: "prod-ws-2", owner: owner._id, metadata: { migratedFromV1: true, migratedAt } });
    await mkForm(owner._id, { workspaceId: ws2._id });
    const blocked = await runV1Migration({ rollback: true });
    expect(blocked.rollbacksSkipped).toBe(1);
  });

  it("never touches workspaces the migration did not create", async () => {
    const owner = await mkUser("normal");
    const ws = await Workspace.create({ name: "Normal", slug: "normal-ws", owner: owner._id });
    await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
    const res = await runV1Migration({ rollback: true });
    expect(res.workspacesRolledBack).toBe(0);
    expect(await Workspace.countDocuments({ _id: ws._id })).toBe(1);
  });
});
