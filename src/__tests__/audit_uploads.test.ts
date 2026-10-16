// The one-off storage audit: compares Upload records with the real files, repairs only what is safe, and refuses to run
// against a folder that is not the real uploads folder.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import fs from "fs";
import os from "os";
import path from "path";
import User from "../models/User";
import Upload from "../models/Upload";
import Workspace from "../models/Workspace";
import { auditUploads, MAX_MISSING_SHARE } from "../scripts/auditUploads";

let mongoServer: MongoMemoryServer;
let dir: string;
let user: any;
let other: any;

const put = (rel: string, bytes: number) => {
  const abs = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(bytes, "x"));
};
const row = (rel: string, size: number, owner: any, uploadTime = new Date()) =>
  Upload.create({ name: path.basename(rel), size, type: "image/png", path: rel, owner: owner._id, chargedTo: owner._id, uploadTime, isBranding: true });
const used = async (u: any) => (await User.findById(u._id).lean())!.storageUsedBytes ?? 0;

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User, Upload, Workspace].map((m: any) => m.init()));
  user = await User.create({ firebaseUid: "uid-au-1", fullName: "Audit One", email: "au1@test.com", role: "admin", status: "active" });
  other = await User.create({ firebaseUid: "uid-au-2", fullName: "Audit Two", email: "au2@test.com", role: "admin", status: "active" });
});
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "beginso-audit-"));
  await Upload.deleteMany({});
  await Workspace.deleteMany({});
  await User.updateMany({}, { $set: { storageUsedBytes: 0 } });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("auditUploads: what it finds", () => {
  it("reports each kind of mismatch, and a dry run changes nothing", async () => {
    const u = String(user._id);
    put(`${u}/f1/brand/brand_logo/ok.png`, 1000);
    await row(`${u}/f1/brand/brand_logo/ok.png`, 1000, user); // fine
    await row(`${u}/f1/brand/brand_logo/gone.png`, 4000, user); // record, no file
    put(`${u}/brand/brand_logo/shared.png`, 2000);
    await row(`${u}/brand/brand_logo/shared.png`, 2000, user, new Date("2026-01-01"));
    await row(`${u}/brand/brand_logo/shared.png`, 3000, other, new Date("2026-02-01")); // legacy: same file, second record
    put(`${u}/f1/brand/brand_logo/wrong.png`, 500);
    await row(`${u}/f1/brand/brand_logo/wrong.png`, 900, user); // size mismatch
    put(`${u}/f1/brand/brand_logo/stray.png`, 700); // file, no record
    await Workspace.create({ name: "W", slug: "au-w", owner: user._id });

    const before = await Upload.countDocuments({});
    const a = await auditUploads({ uploadDir: dir });

    expect(a.rows).toBe(5);
    expect(a.missingFile.map((r) => r.path)).toEqual([`${u}/f1/brand/brand_logo/gone.png`]);
    expect(a.sharedPath).toEqual([{ path: `${u}/brand/brand_logo/shared.png`, rows: 2, realBytes: 2000, chargedBytes: 5000 }]);
    expect(a.sizeMismatch).toEqual([expect.objectContaining({ recorded: 900, real: 500 })]);
    expect(a.orphanFiles).toEqual([{ path: `${u}/f1/brand/brand_logo/stray.png`, bytes: 700 }]);
    expect(a.unreferencedUserImages.map((i) => i.path)).toEqual([`${u}/brand/brand_logo/shared.png`]);
    expect(a.changed).toBe(false);
    expect(await Upload.countDocuments({})).toBe(before);
  });

  it("an image a form, workspace or profile refers to is not reported as unreferenced", async () => {
    const u = String(user._id);
    put(`${u}/brand/brand_logo/in-use.png`, 800);
    await row(`${u}/brand/brand_logo/in-use.png`, 800, user);
    await Workspace.create({ name: "Uses it", slug: "au-uses", owner: user._id, logo: `https://old-host.example/api/upload/file/${u}/brand/brand_logo/in-use.png` });
    expect((await auditUploads({ uploadDir: dir })).unreferencedUserImages).toEqual([]);
  });

  it("a clean install reports nothing", async () => {
    const u = String(user._id);
    put(`${u}/f1/brand/brand_logo/a.png`, 100);
    await row(`${u}/f1/brand/brand_logo/a.png`, 100, user);
    const a = await auditUploads({ uploadDir: dir });
    expect([a.missingFile, a.sharedPath, a.sizeMismatch, a.orphanFiles, a.perUser].map((x) => x.length)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("auditUploads --apply", () => {
  it("removes records with no file, collapses shared records to the newest, fixes sizes, and recomputes the counters", async () => {
    const u = String(user._id);
    put(`${u}/f1/brand/brand_logo/ok.png`, 1000);
    await row(`${u}/f1/brand/brand_logo/ok.png`, 1000, user);
    await row(`${u}/f1/brand/brand_logo/gone.png`, 4000, user);
    put(`${u}/brand/brand_logo/shared.png`, 2000);
    await row(`${u}/brand/brand_logo/shared.png`, 2000, user, new Date("2026-01-01"));
    const newest = await row(`${u}/brand/brand_logo/shared.png`, 3000, user, new Date("2026-02-01"));
    put(`${u}/f1/brand/brand_logo/wrong.png`, 500);
    await row(`${u}/f1/brand/brand_logo/wrong.png`, 900, user);
    expect(await used(user)).toBe(1000 + 4000 + 2000 + 3000 + 900); // what the counter claims now

    const a = await auditUploads({ uploadDir: dir, apply: true });
    expect(a.refused).toBeUndefined();
    expect(a.changed).toBe(true);

    const left = await Upload.find({}).lean();
    expect(left.map((r) => r.path).sort()).toEqual([`${u}/brand/brand_logo/shared.png`, `${u}/f1/brand/brand_logo/ok.png`, `${u}/f1/brand/brand_logo/wrong.png`].sort());
    expect(left.find((r) => r.path.endsWith("shared.png"))!._id.toString()).toBe(String(newest._id)); // newest kept
    expect(left.find((r) => r.path.endsWith("shared.png"))!.size).toBe(2000); // real size
    expect(left.find((r) => r.path.endsWith("wrong.png"))!.size).toBe(500);
    expect(await used(user)).toBe(1000 + 2000 + 500); // exactly the real files

    expect(fs.existsSync(path.join(dir, ...`${u}/brand/brand_logo/shared.png`.split("/")))).toBe(true); // never deletes a file
  });

  it("never deletes a stray file or an unreferenced image, only reports them", async () => {
    const u = String(user._id);
    put(`${u}/f1/brand/brand_logo/stray.png`, 700);
    put(`${u}/brand/brand_logo/avatar.png`, 900);
    await row(`${u}/brand/brand_logo/avatar.png`, 900, user);
    await auditUploads({ uploadDir: dir, apply: true });
    expect(fs.existsSync(path.join(dir, ...`${u}/f1/brand/brand_logo/stray.png`.split("/")))).toBe(true);
    expect(fs.existsSync(path.join(dir, ...`${u}/brand/brand_logo/avatar.png`.split("/")))).toBe(true);
    expect(await Upload.countDocuments({})).toBe(1);
  });

  it("is idempotent: a second run has nothing to repair", async () => {
    const u = String(user._id);
    await row(`${u}/f1/brand/brand_logo/gone.png`, 4000, user);
    for (let i = 0; i < 5; i += 1) {
      put(`${u}/f1/brand/brand_logo/ok-${i}.png`, 100);
      await row(`${u}/f1/brand/brand_logo/ok-${i}.png`, 100, user);
    }
    const first = await auditUploads({ uploadDir: dir, apply: true });
    expect(first.changed).toBe(true);
    const again = await auditUploads({ uploadDir: dir, apply: true });
    expect(again.changed).toBe(false);
    expect(await used(user)).toBe(500);
  });
});

describe("auditUploads safety: it must not run against the wrong folder", () => {
  it("refuses to apply when the uploads folder does not exist, and changes nothing", async () => {
    const u = String(user._id);
    await row(`${u}/f1/brand/brand_logo/a.png`, 100, user);
    const a = await auditUploads({ uploadDir: path.join(dir, "nope"), apply: true });
    expect(a.refused).toMatch(/does not exist/);
    expect(await Upload.countDocuments({})).toBe(1);
  });

  it(`refuses to apply when more than ${MAX_MISSING_SHARE * 100}% of the records have no file (the signature of a laptop pointed at production)`, async () => {
    const u = String(user._id);
    put(`${u}/f1/brand/brand_logo/only-one.png`, 100);
    await row(`${u}/f1/brand/brand_logo/only-one.png`, 100, user);
    for (let i = 0; i < 4; i += 1) await row(`${u}/f1/brand/brand_logo/missing-${i}.png`, 100, user);
    const a = await auditUploads({ uploadDir: dir, apply: true });
    expect(a.refused).toMatch(/probably not the right uploads folder/);
    expect(await Upload.countDocuments({})).toBe(5); // every record still there
    expect(a.changed).toBe(false);
  });

  it("a dry run against the wrong folder still just reports, so the operator can see the problem", async () => {
    const u = String(user._id);
    await row(`${u}/f1/brand/brand_logo/a.png`, 100, user);
    const a = await auditUploads({ uploadDir: path.join(dir, "nope") });
    expect(a.missingFile).toHaveLength(1);
    expect(a.refused).toBeUndefined();
    expect(await Upload.countDocuments({})).toBe(1);
  });
});
