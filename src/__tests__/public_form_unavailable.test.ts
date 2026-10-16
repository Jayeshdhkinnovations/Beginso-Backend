// QA A5-001 / A5-003: a closed form, a passed closing date and a full response limit used to look exactly like a link
// that never existed ("Form not found"). Each now answers 410 with its own error.code. What stays an identical 404:
// a draft, an archived form, an unknown slug and an owner past their storage ceiling, so a link never confirms that a
// draft exists and never reveals anything about the owner's account.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { clearRateLimitStore } from "../middleware/rateLimiter";

process.env.JWT_SECRET = "test-jwt-secret-key-for-public-unavailable";

let mongoServer: MongoMemoryServer;
let owner: any;
let ws: any;
let n = 0;

const mkForm = (extra: any = {}) => {
  n += 1;
  return Form.create({
    title: "Public",
    workspaceId: ws._id,
    createdBy: owner._id,
    status: "published",
    slug: `unav-${n}`,
    publishedSlug: `unav-${n}`,
    fields: [{ fieldId: "f1", label: "Name", type: "short_text", required: false }],
    ...extra,
  });
};
const get = (slug: string) => request(app).get(`/api/public/${slug}`);
const submit = (slug: string) => request(app).post(`/api/public/${slug}/submit`).send({ f1: "x" });
const past = () => new Date(Date.now() - 3_600_000).toISOString();

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  owner = await User.create({ firebaseUid: "uid-unav-owner", fullName: "Unav Owner", email: "unav-owner@test.com", role: "admin", status: "active" });
  ws = await Workspace.create({ name: "Unav WS", slug: "unav-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
});
beforeEach(() => clearRateLimitStore());
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("states the owner chose answer 410 with a reason", () => {
  it("closed by hand: FORM_CLOSED on GET and on submit", async () => {
    const f: any = await mkForm({ status: "closed" });
    for (const res of [await get(f.publishedSlug), await submit(f.publishedSlug)]) {
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe("FORM_CLOSED");
      expect(res.body.success).toBe(false);
      expect(typeof res.body.message).toBe("string");
    }
  });

  it("past its closing date: FORM_CLOSE_DATE_PASSED, whether or not the status was already swept to closed", async () => {
    const live: any = await mkForm({ settings: { closeDate: past() } });
    expect((await get(live.publishedSlug)).body.error.code).toBe("FORM_CLOSE_DATE_PASSED");
    const swept: any = await mkForm({ status: "closed", settings: { closeDate: past() } });
    expect((await get(swept.publishedSlug)).body.error.code).toBe("FORM_CLOSE_DATE_PASSED"); // not just "closed"
  });

  it("response limit reached: FORM_RESPONSE_LIMIT_REACHED, also after the form auto-closed", async () => {
    const f: any = await mkForm({ settings: { responseLimitEnabled: true, responseLimit: 1 } });
    await ResponseModel.create({ formId: f._id, answers: {} });
    const res = await get(f.publishedSlug);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("FORM_RESPONSE_LIMIT_REACHED");
    expect((await submit(f.publishedSlug)).body.error.code).toBe("FORM_RESPONSE_LIMIT_REACHED"); // flips it to closed
    expect((await get(f.publishedSlug)).body.error.code).toBe("FORM_RESPONSE_LIMIT_REACHED"); // still explains why
  });

  it("an open form is unaffected", async () => {
    const f: any = await mkForm();
    expect((await get(f.publishedSlug)).status).toBe(200);
  });
});

describe("everything else stays one indistinguishable 404", () => {
  const sameAsUnknown = async (slug: string) => {
    const res = await get(slug);
    const unknown = await get("no-such-form-slug");
    expect(res.status).toBe(404);
    expect(res.body).toEqual(unknown.body);
    expect(res.body.error?.code).toBeUndefined();
  };

  it("a draft", async () => {
    const f: any = await mkForm({ status: "draft" });
    await sameAsUnknown(f.publishedSlug);
  });

  it("a draft with a passed closing date and a full limit never reveals either", async () => {
    const f: any = await mkForm({ status: "draft", settings: { closeDate: past(), responseLimitEnabled: true, responseLimit: 1 } });
    await ResponseModel.create({ formId: f._id, answers: {} });
    await sameAsUnknown(f.publishedSlug);
  });

  it("an archived form, even one that is also closed", async () => {
    const a: any = await mkForm({ archivedAt: new Date() });
    await sameAsUnknown(a.publishedSlug);
    const b: any = await mkForm({ status: "closed", archivedAt: new Date() });
    await sameAsUnknown(b.publishedSlug);
  });

  it("an unknown slug", async () => {
    expect((await get("never-existed")).status).toBe(404);
  });

  it("submitting to a draft or unknown slug is the same 404", async () => {
    const f: any = await mkForm({ status: "draft" });
    expect((await submit(f.publishedSlug)).status).toBe(404);
    expect((await submit("never-existed")).status).toBe(404);
  });
});
