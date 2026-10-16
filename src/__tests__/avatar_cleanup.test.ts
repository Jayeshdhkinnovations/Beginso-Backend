// QA A8-003: removing or replacing an avatar only changed the profile's URL, so the old file and its Upload row stayed
// forever and kept counting against the owner's storage.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import app from "../app";
import User from "../models/User";
import Upload from "../models/Upload";
import Form from "../models/Form";
import { clearRateLimitStore } from "../middleware/rateLimiter";
import { generateToken } from "../utils/generateToken";

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "beginso-avatar-"));
process.env.UPLOAD_DIR = uploadDir;
process.env.JWT_SECRET = "test-jwt-secret-key-for-avatar-cleanup";

let mongoServer: MongoMemoryServer;
let user: any;
let other: any;

const auth = (u: any) => ({ Authorization: `Bearer ${generateToken({ id: u._id.toString(), email: u.email, role: u.role })}` });
const used = async (u: any = user): Promise<number> => (await User.findById(u._id).lean())!.storageUsedBytes ?? 0;
const upload = async (u: any, bytes: number) => {
  const res = await request(app)
    .post("/api/upload")
    .set(auth(u))
    .field("type", "branding")
    .attach("logo", Buffer.alloc(bytes, "x"), { filename: "me.png", contentType: "image/png" });
  expect(res.status).toBe(201);
  return res.body.url as string;
};
const setAvatar = (u: any, avatarUrl: string | null) => request(app).patch("/api/users/me").set(auth(u)).send({ avatarUrl });
const onDisk = (url: string) => fs.existsSync(path.join(uploadDir, ...new URL(url).pathname.replace("/api/upload/file/", "").split("/")));
const rows = (u: any = user) => Upload.countDocuments({ owner: u._id });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User, Upload, Form].map((m: any) => m.init()));
  user = await User.create({ firebaseUid: "uid-av-1", fullName: "Avatar One", email: "av1@test.com", role: "admin", status: "active" });
  other = await User.create({ firebaseUid: "uid-av-2", fullName: "Avatar Two", email: "av2@test.com", role: "admin", status: "active" });
});
beforeEach(async () => {
  clearRateLimitStore();
  await Upload.deleteMany({});
  await User.updateMany({}, { $set: { storageUsedBytes: 0, avatarUrl: null } });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("avatar files are removed when the avatar is replaced or removed", () => {
  it("removing the photo deletes the file and the upload row and gives the storage back", async () => {
    const url = await upload(user, 4000);
    expect((await setAvatar(user, url)).status).toBe(200);
    expect(await used()).toBe(4000);
    expect(onDisk(url)).toBe(true);

    expect((await setAvatar(user, null)).status).toBe(200);
    expect(onDisk(url)).toBe(false);
    expect(await rows()).toBe(0);
    expect(await used()).toBe(0);
  });

  it("replacing the photo frees the old one and keeps the new one", async () => {
    const first = await upload(user, 3000);
    await setAvatar(user, first);
    const second = await upload(user, 5000);
    expect((await setAvatar(user, second)).status).toBe(200);

    expect(onDisk(first)).toBe(false);
    expect(onDisk(second)).toBe(true);
    expect(await rows()).toBe(1);
    expect(await used()).toBe(5000);
    expect((await User.findById(user._id).lean())!.avatarUrl).toBe(second);
  });

  it("two uploads with the same file name no longer land on one file, so one cannot overwrite or delete the other", async () => {
    const one = await upload(user, 1000);
    const two = await upload(user, 2000); // same name ("me.png") as the first
    expect(one).not.toBe(two);
    expect(onDisk(one)).toBe(true);
    expect(onDisk(two)).toBe(true);
    expect(await rows()).toBe(2);
    expect(await used()).toBe(3000);
  });

  it("saving the same avatar again, or a name change, deletes nothing", async () => {
    const url = await upload(user, 2000);
    await setAvatar(user, url);
    await setAvatar(user, url);
    await request(app).patch("/api/users/me").set(auth(user)).send({ name: "Renamed" });
    expect(onDisk(url)).toBe(true);
    expect(await used()).toBe(2000);
  });

  it("a file that a form still uses as its logo is not deleted", async () => {
    const url = await upload(user, 2500);
    await Form.create({ title: "Uses it", createdBy: user._id, workspaceId: null, fields: [], branding: { logoUrl: url } });
    await setAvatar(user, url);
    await setAvatar(user, null);
    expect(onDisk(url)).toBe(true);
    expect(await rows()).toBe(1);
  });

  it("an avatar that points at someone else's upload, or an outside image, is never touched", async () => {
    const theirs = await upload(other, 1500);
    await setAvatar(user, theirs); // pointing at another user's file
    await setAvatar(user, "https://images.example.com/photo.png");
    expect(onDisk(theirs)).toBe(true);
    expect(await rows(other)).toBe(1);
    await setAvatar(user, null);
    expect(await rows(other)).toBe(1);
  });

  it("an upload that belongs to a form (a form-level logo) is never treated as an avatar", async () => {
    const form: any = await Form.create({ title: "F", createdBy: user._id, workspaceId: null, fields: [] });
    const res = await request(app)
      .post("/api/upload")
      .set(auth(user))
      .field("formId", form._id.toString())
      .field("type", "branding")
      .attach("logo", Buffer.alloc(1200, "x"), { filename: "form-logo.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    await setAvatar(user, res.body.url);
    await setAvatar(user, null);
    expect(onDisk(res.body.url)).toBe(true);
    expect(await rows()).toBe(1);
  });
});
