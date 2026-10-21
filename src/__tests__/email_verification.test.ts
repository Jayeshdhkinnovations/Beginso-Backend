// "Anyone with the link, with their email": the respondent verifies the address before submitting. One suite per guarantee:
// the email carries only a link, the browser that asked (and only it) can redeem the proof, the proof is single use and tied to
// the address and the form, expired or forged proofs are refused, and a tracked form cannot be published without an email question.
process.env.JWT_SECRET = "test-jwt-secret-key-for-email-verification";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "1000";
process.env.EMAIL_TARGET_RATE_LIMIT_MAX = "1000";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import EmailVerification from "../models/EmailVerification";
import { generateToken } from "../utils/generateToken";
import { mailService } from "../services/mail.service";
import { renderEmailVerifyEmail } from "../services/respondentMail";
import { evaluateReadiness } from "../services/readiness.service";

let mongoServer: MongoMemoryServer;
let owner: any, ws: any;
const as = (u: any) => ({ Authorization: `Bearer ${generateToken({ id: u._id.toString(), email: u.email, role: "user" })}`, "x-workspace-slug": "ws-ev" });

const fields = (withEmail = true) => [
  { fieldId: "f-name", pageId: "p1", label: "Full name", type: "short_text", required: true },
  ...(withEmail ? [{ fieldId: "f-email", pageId: "p1", label: "Email", type: "email", required: true }] : []),
];
const mkForm = async (settings: any = { accessMode: "tracked" }, withEmail = true): Promise<any> =>
  Form.create({
    title: "Verified form",
    workspaceId: ws._id,
    createdBy: owner._id,
    status: "draft",
    fields: fields(withEmail),
    pages: [{ id: "p1", order: 0, title: "Page one" }],
    settings,
  } as any);
const publish = async (form: any) => (await request(app).post(`/api/forms/${form._id}/publish`).set(as(owner)).send({})).body.slug as string;

const submit = (slug: string, extra: Record<string, any>, answers: Record<string, any> = { "f-name": "Bea", "f-email": "bea@example.com" }) =>
  request(app)
    .post(`/api/public/${slug}/submit`)
    .field("data", JSON.stringify({ answers: Object.entries(answers).map(([fieldId, value]) => ({ fieldId, value })), ...extra }));

let spy: jest.SpyInstance;
let mails: any[];
beforeEach(() => {
  mails = [];
  spy = jest.spyOn(mailService, "sendMail").mockImplementation(async (o: any) => {
    mails.push(o);
    return true;
  });
});
afterEach(() => spy.mockRestore());

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Workspace.init(), Membership.init(), Form.init(), ResponseModel.init(), EmailVerification.init()]);
  owner = await User.create({ firebaseUid: "uid-ev-owner", fullName: "Owner", email: "owner@ev.test", status: "active" });
  ws = await Workspace.create({ name: "EV", slug: "ws-ev", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const tokenFrom = (mail: any): string => String(mail.actionUrl).split("/confirm-email/")[1];
const ask = (slug: string, email: string) => request(app).post(`/api/public/${slug}/verify-email`).send({ email });
const confirm = (token: string) => request(app).post("/api/public/email-verification/confirm").send({ token });
const status = (slug: string, id: string) => request(app).get(`/api/public/${slug}/verify-email/${id}`);

describe("asking for the verification email", () => {
  it("sends one mail to the address with a link, and gives the browser a separate secret", async () => {
    const slug = await publish(await mkForm());
    const res = await ask(slug, " Bea@Example.com ");
    expect(res.status).toBe(200);
    expect(typeof res.body.verificationId).toBe("string");
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "bea@example.com", template: "respondent_email_verify", formName: "Verified form" });
    expect(mails[0].actionUrl).toMatch(/\/confirm-email\/[\w-]{20,}$/);
    expect(mails[0].actionUrl).not.toContain(res.body.verificationId); // the link and the secret are different things
    expect(Object.keys(mails[0]).sort()).toEqual(["actionUrl", "expiresAt", "formName", "template", "to"]);
  });

  it("refuses a malformed address, and a form that does not ask for verified email", async () => {
    const tracked = await publish(await mkForm());
    const open = await publish(await mkForm({ accessMode: "open" }));
    expect((await ask(tracked, "nope")).status).toBe(422);
    expect((await ask(open, "bea@example.com")).body.error.code).toBe("VERIFICATION_NOT_REQUIRED");
    expect(mails).toHaveLength(0);
  });

  it("says so when the email could not be sent, and leaves nothing behind", async () => {
    const slug = await publish(await mkForm());
    spy.mockResolvedValueOnce(false);
    const before = await EmailVerification.countDocuments();
    const res = await ask(slug, "bea@example.com");
    expect(res.status).toBe(502);
    expect(res.body.error?.code ?? res.body.code).toBeTruthy();
    expect(await EmailVerification.countDocuments()).toBe(before);
  });

  it("the email holds the form name and one button, and escapes a hostile name", () => {
    const html = renderEmailVerifyEmail({ formName: '<script>alert("x")</script>', actionUrl: "https://beginso.com/confirm-email/abc", expiresAt: new Date(Date.now() + 30 * 60000) }).html;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("https://beginso.com/confirm-email/abc");
  });
});

describe("the whole flow: ask, click the link, submit", () => {
  it("pending until the link is clicked, then verified, then one submission goes through and the track-your-response mail follows", async () => {
    const form = await mkForm();
    const slug = await publish(form);
    const { verificationId } = (await ask(slug, "bea@example.com")).body;
    expect((await status(slug, verificationId)).body).toMatchObject({ status: "pending", email: "bea@example.com" });

    // not yet clicked: the submit is refused
    const early = await submit(slug, { respondentEmail: "bea@example.com", emailVerificationId: verificationId });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe("EMAIL_NOT_VERIFIED");

    const clicked = await confirm(tokenFrom(mails[0]));
    expect(clicked.status).toBe(200);
    expect(clicked.body).toMatchObject({ success: true, state: "verified" });
    expect((await confirm(tokenFrom(mails[0]))).body.state).toBe("verified"); // a second click is harmless
    expect((await status(slug, verificationId)).body).toMatchObject({ status: "verified", email: "bea@example.com" });

    const ok = await submit(slug, { respondentEmail: "bea@example.com", emailVerificationId: verificationId });
    expect(ok.status).toBe(200);
    const stored = await ResponseModel.findOne({ formId: form._id });
    expect(stored!.respondentEmail).toBe("bea@example.com");
    expect(mails.map((m) => m.template)).toEqual(["respondent_email_verify", "respondent_submission_link"]); // then the same tracking link as before

    // single use: the same proof cannot submit again
    const again = await submit(slug, { respondentEmail: "bea@example.com", emailVerificationId: verificationId });
    expect(again.status).toBe(422);
    expect((await status(slug, verificationId)).body.status).toBe("invalid");
  });

  it("the proof is tied to the address: another address with the same proof is refused", async () => {
    const slug = await publish(await mkForm());
    const { verificationId } = (await ask(slug, "bea@example.com")).body;
    await confirm(tokenFrom(mails[0]));
    const res = await submit(slug, { respondentEmail: "someone-else@example.com", emailVerificationId: verificationId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("the proof is tied to the form: it cannot be used on another form", async () => {
    const a = await publish(await mkForm());
    const b = await publish(await mkForm());
    const { verificationId } = (await ask(a, "bea@example.com")).body;
    await confirm(tokenFrom(mails[0]));
    expect((await submit(b, { respondentEmail: "bea@example.com", emailVerificationId: verificationId })).status).toBe(422);
    expect((await status(b, verificationId)).body.status).toBe("invalid");
  });

  it("only the browser holding the secret can use it: the link token is not a submit proof", async () => {
    const slug = await publish(await mkForm());
    await ask(slug, "bea@example.com");
    const linkToken = tokenFrom(mails[0]);
    await confirm(linkToken);
    expect((await submit(slug, { respondentEmail: "bea@example.com", emailVerificationId: linkToken })).status).toBe(422);
    expect((await submit(slug, { respondentEmail: "bea@example.com", emailVerificationId: "x".repeat(43) })).status).toBe(422);
    expect((await submit(slug, { respondentEmail: "bea@example.com" })).status).toBe(422);
  });

  it("a link that never existed is 404, and an expired link or an expired proof is refused", async () => {
    const slug = await publish(await mkForm());
    expect((await confirm("y".repeat(43))).status).toBe(404);
    expect((await confirm("short")).status).toBe(404);

    const { verificationId } = (await ask(slug, "bea@example.com")).body;
    await EmailVerification.updateMany({ email: "bea@example.com", verifiedAt: null }, { $set: { linkExpiresAt: new Date(Date.now() - 1000) } });
    const late = await confirm(tokenFrom(mails[0]));
    expect(late.body.state).toBe("expired");
    expect((await status(slug, verificationId)).body.status).toBe("expired");

    mails = [];
    const second = (await ask(slug, "cy@example.com")).body.verificationId;
    await confirm(tokenFrom(mails[0]));
    await EmailVerification.updateMany({ email: "cy@example.com" }, { $set: { proofExpiresAt: new Date(Date.now() - 1000) } });
    expect((await submit(slug, { respondentEmail: "cy@example.com", emailVerificationId: second })).status).toBe(422);
  });

  it("the secret may also travel in a header", async () => {
    const slug = await publish(await mkForm());
    const { verificationId } = (await ask(slug, "bea@example.com")).body;
    await confirm(tokenFrom(mails[0]));
    const res = await request(app)
      .post(`/api/public/${slug}/submit`)
      .set("x-email-verification", verificationId)
      .field("data", JSON.stringify({ answers: [{ fieldId: "f-name", value: "Bea" }, { fieldId: "f-email", value: "bea@example.com" }], respondentEmail: "bea@example.com" }));
    expect(res.status).toBe(200);
  });
});

describe("a tracked form needs an Email question", () => {
  it("readiness blocks it, with a stable code, and publishing is refused", async () => {
    const form = await mkForm({ accessMode: "tracked" }, false);
    const readiness = evaluateReadiness(form);
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking.map((i) => i.code)).toContain("TRACKED_NEEDS_EMAIL_FIELD");
    const res = await request(app).post(`/api/forms/${form._id}/publish`).set(as(owner)).send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("a deleted Email question does not count, and other modes never need one", async () => {
    const deleted = await mkForm({ accessMode: "tracked" });
    deleted.fields[1].deleted = true;
    expect(evaluateReadiness(deleted).blocking.map((i) => i.code)).toContain("TRACKED_NEEDS_EMAIL_FIELD");
    const open = await mkForm({ accessMode: "open" }, false);
    expect(evaluateReadiness(open).blocking.map((i) => i.code)).not.toContain("TRACKED_NEEDS_EMAIL_FIELD");
    const withEmail = await mkForm({ accessMode: "tracked" });
    expect(evaluateReadiness(withEmail).ready).toBe(true);
  });
});
