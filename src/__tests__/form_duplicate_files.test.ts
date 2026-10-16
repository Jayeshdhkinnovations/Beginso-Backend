// A duplicate's logo and cover must be the COPY's own files. Pointing at the original's files meant that purging the
// original deleted the folder they live in and broke the copy's images.
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
import { deleteFormData } from "../services/cleanup.service";

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "beginso-dupfiles-"));
process.env.UPLOAD_DIR = uploadDir;
process.env.JWT_SECRET = "test-jwt-secret-key-for-duplicate-files";

let mongoServer: MongoMemoryServer;
let user: any;

const auth = () => ({ Authorization: `Bearer ${generateToken({ id: user._id.toString(), email: user.email, role: user.role })}` });
const used = async (): Promise<number> => (await User.findById(user._id).lean())!.storageUsedBytes ?? 0;
const fileOf = (url: string) => path.join(uploadDir, ...new URL(url).pathname.replace("/api/upload/file/", "").split("/"));
const upload = async (formId: string | null, kind: "logo" | "cover", bytes: number) => {
  const req = request(app).post("/api/upload").set(auth()).field("type", kind === "cover" ? "cover" : "branding");
  if (formId) req.field("formId", formId);
  const res = await req.attach(kind, Buffer.alloc(bytes, kind === "logo" ? "L" : "C"), { filename: `${kind}.png`, contentType: "image/png" });
  expect(res.status).toBe(201);
  return res.body.url as string;
};
const duplicate = (formId: string) => request(app).post(`/api/forms/${formId}/duplicate`).set({ ...auth(), "x-workspace-slug": "personal" });

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([User, Upload, Form].map((m: any) => m.init()));
  user = await User.create({ firebaseUid: "uid-df-1", fullName: "Dup Files", email: "df1@test.com", role: "admin", status: "active" });
});
beforeEach(async () => {
  clearRateLimitStore();
  await Upload.deleteMany({});
  await Form.deleteMany({});
  await User.updateOne({ _id: user._id }, { $set: { storageUsedBytes: 0 }, $unset: { storageQuotaBytes: 1 } });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const formWithImages = async () => {
  const form: any = await Form.create({ title: "Branded", createdBy: user._id, workspaceId: null, fields: [] });
  const logoUrl = await upload(String(form._id), "logo", 3000);
  const coverImageUrl = await upload(String(form._id), "cover", 5000);
  await Form.updateOne({ _id: form._id }, { $set: { "branding.logoUrl": logoUrl, "branding.coverImageUrl": coverImageUrl, "branding.primaryColor": "#DC2626" } });
  return { form, logoUrl, coverImageUrl };
};

describe("a duplicate gets its own copies of the form's images", () => {
  it("copies the logo and cover into the new form's folder, with their own Upload rows, and charges the storage", async () => {
    const { form, logoUrl, coverImageUrl } = await formWithImages();
    const before = await used();
    expect(before).toBeGreaterThanOrEqual(8000); // both images, plus the form record

    const res = await duplicate(String(form._id));
    expect(res.status).toBe(201);
    const copy: any = await Form.findById(res.body.form._id).lean();

    expect(copy.branding.logoUrl).not.toBe(logoUrl);
    expect(copy.branding.coverImageUrl).not.toBe(coverImageUrl);
    expect(copy.branding.logoUrl).toContain(`/${copy._id}/`);
    expect(copy.branding.coverImageUrl).toContain(`/${copy._id}/`);
    expect(copy.branding.primaryColor).toBe("#DC2626"); // the rest of the look is kept
    for (const url of [logoUrl, coverImageUrl, copy.branding.logoUrl, copy.branding.coverImageUrl]) expect(fs.existsSync(fileOf(url))).toBe(true);
    expect(fs.readFileSync(fileOf(copy.branding.logoUrl)).equals(fs.readFileSync(fileOf(logoUrl)))).toBe(true); // same picture
    expect(await Upload.countDocuments({})).toBe(4);
    expect(await used()).toBeGreaterThanOrEqual(before + 8000); // the copy's two images are charged like any upload
  });

  it("deleting the original removes ITS files and leaves the copy's images working (the reported hazard)", async () => {
    const { form, logoUrl, coverImageUrl } = await formWithImages();
    const copy: any = await Form.findById((await duplicate(String(form._id))).body.form._id).lean();

    await deleteFormData(String(form._id));

    expect(fs.existsSync(fileOf(logoUrl))).toBe(false);
    expect(fs.existsSync(fileOf(coverImageUrl))).toBe(false);
    expect(fs.existsSync(fileOf(copy.branding.logoUrl))).toBe(true);
    expect(fs.existsSync(fileOf(copy.branding.coverImageUrl))).toBe(true);
    expect(await Upload.countDocuments({ path: { $regex: String(copy._id) } })).toBe(2);
    expect(await Upload.countDocuments({ path: { $regex: String(form._id) } })).toBe(0);
  });

  it("can be repeated: a copy of a copy has its own files again", async () => {
    const { form } = await formWithImages();
    const copy1: any = await Form.findById((await duplicate(String(form._id))).body.form._id).lean();
    const copy2: any = await Form.findById((await duplicate(String(copy1._id))).body.form._id).lean();
    expect(copy2.branding.logoUrl).toContain(`/${copy2._id}/`);
    expect(new Set([copy1.branding.logoUrl, copy2.branding.logoUrl]).size).toBe(2);
  });

  it("leaves an image that is not in the form's own folder alone (an outside link, or a workspace default)", async () => {
    const shared = await upload(null, "logo", 1500); // user-level, not inside any form's folder
    const form: any = await Form.create({ title: "Uses defaults", createdBy: user._id, workspaceId: null, fields: [], branding: { logoUrl: shared, coverImageUrl: "https://images.example.com/c.png" } });
    const copy: any = await Form.findById((await duplicate(String(form._id))).body.form._id).lean();
    expect(copy.branding.logoUrl).toBe(shared);
    expect(copy.branding.coverImageUrl).toBe("https://images.example.com/c.png");
    expect(await Upload.countDocuments({})).toBe(1); // nothing was copied
  });

  it("is refused without leaving anything behind when there is no room for the extra files", async () => {
    const { form } = await formWithImages();
    await User.updateOne({ _id: user._id }, { $set: { storageQuotaBytes: 10_000 } }); // 8000 used: no room for 8000 more
    const filesBefore = JSON.stringify(fs.readdirSync(path.join(uploadDir, String(user._id))).sort());
    const formsBefore = await Form.countDocuments({});

    const res = await duplicate(String(form._id));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await Form.countDocuments({})).toBe(formsBefore);
    expect(await Upload.countDocuments({})).toBe(2);
    expect(JSON.stringify(fs.readdirSync(path.join(uploadDir, String(user._id))).sort())).toBe(filesBefore);
  });

  it("a form with no images duplicates as before", async () => {
    const form: any = await Form.create({ title: "Plain", createdBy: user._id, workspaceId: null, fields: [], branding: { primaryColor: "#000000" } });
    const res = await duplicate(String(form._id));
    expect(res.status).toBe(201);
    expect(((await Form.findById(res.body.form._id).lean()) as any).branding.primaryColor).toBe("#000000");
  });
});
