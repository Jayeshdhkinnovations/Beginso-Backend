// "Anyone, with a verified email": the respondent proves the address with a 6-digit code BEFORE the form starts. One suite per guarantee:
// the email carries only the code, the browser that asked (and only it) can redeem the proof, guessing is capped, the proof is single use
// and tied to the form, the stored address is the VERIFIED one (never the request's), a signed-in account is the other way in, an account
// sees the submissions it verified as its own, and a stored "login" mode reads as the same gate.
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
import { renderEmailCodeEmail } from "../services/respondentMail";
import { evaluateReadiness } from "../services/readiness.service";
import { getAccessMode } from "../utils/accessMode";
import { listMine } from "../services/respondent.service";
import { MAX_ATTEMPTS } from "../services/emailVerification.service";

let mongoServer: MongoMemoryServer;
let owner: any, guestAccount: any, ws: any;
const as = (u: any) => ({ Authorization: `Bearer ${generateToken({ id: u._id.toString(), email: u.email, role: "user" })}`, "x-workspace-slug": "ws-ev" });

const fields = () => [
  { fieldId: "f-name", pageId: "p1", label: "Full name", type: "short_text", required: true },
  { fieldId: "f-note", pageId: "p1", label: "Note", type: "short_text", required: false },
];
const mkForm = async (settings: any = { accessMode: "tracked" }): Promise<any> =>
  Form.create({
    title: "Verified form",
    workspaceId: ws._id,
    createdBy: owner._id,
    status: "draft",
    fields: fields(),
    pages: [{ id: "p1", order: 0, title: "Page one" }],
    settings,
  } as any);
const publish = async (form: any) => (await request(app).post(`/api/forms/${form._id}/publish`).set(as(owner)).send({})).body.slug as string;

const submit = (slug: string, extra: Record<string, any> = {}, headers: Record<string, string> = {}) =>
  request(app)
    .post(`/api/public/${slug}/submit`)
    .set(headers)
    .field("data", JSON.stringify({ answers: [{ fieldId: "f-name", value: "Bea" }], ...extra }));

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
  guestAccount = await User.create({ firebaseUid: "uid-ev-guest", fullName: "Bea Account", email: "bea@example.com", status: "active" });
  ws = await Workspace.create({ name: "EV", slug: "ws-ev", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const ask = (slug: string, email: string) => request(app).post(`/api/public/${slug}/verify-email`).send({ email });
const typeCode = (slug: string, id: string, code: string) => request(app).post(`/api/public/${slug}/verify-email/${id}/code`).send({ code });
const lastCode = (): string => mails[mails.length - 1].code;

describe("asking for the code", () => {
  it("sends one mail with a 6-digit code, and gives the browser a secret that is not the code", async () => {
    const slug = await publish(await mkForm());
    const res = await ask(slug, " Bea@Example.com ");
    expect(res.status).toBe(200);
    expect(typeof res.body.verificationId).toBe("string");
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "bea@example.com", template: "respondent_email_code", formName: "Verified form" });
    expect(mails[0].code).toMatch(/^\d{6}$/);
    expect(res.body.verificationId).not.toContain(mails[0].code);
    expect(JSON.stringify(res.body)).not.toContain(mails[0].code); // the code only ever goes by email
    expect(Object.keys(mails[0]).sort()).toEqual(["code", "expiresAt", "formName", "template", "to"]);
  });

  it("refuses a malformed address, and a form that does not ask for a verified email", async () => {
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
    expect(await EmailVerification.countDocuments()).toBe(before);
  });

  it("the email holds the form name and the code, and escapes a hostile name", () => {
    const rendered = renderEmailCodeEmail({ formName: '<script>alert("x")</script>', code: "123456", expiresAt: new Date(Date.now() + 10 * 60000) });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("123456");
    expect(rendered.subject).toContain("123456");
  });
});

describe("the whole flow: ask, type the code, submit", () => {
  it("a wrong code is refused with the tries left, the right one verifies, and one submit goes through with the VERIFIED address", async () => {
    const form = await mkForm();
    const slug = await publish(form);
    const { verificationId } = (await ask(slug, "bea@example.com")).body;

    // not yet verified: the submit is refused
    const early = await submit(slug, { emailVerificationId: verificationId });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe("EMAIL_NOT_VERIFIED");

    const wrong = await typeCode(slug, verificationId, lastCode() === "000000" ? "111111" : "000000");
    expect(wrong.status).toBe(422);
    expect(wrong.body).toMatchObject({ state: "wrong", attemptsLeft: 4 });

    const ok = await typeCode(slug, verificationId, ` ${lastCode().slice(0, 3)} ${lastCode().slice(3)} `); // spaces are forgiven
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ success: true, state: "verified", email: "bea@example.com" });
    expect((await typeCode(slug, verificationId, lastCode())).body.state).toBe("verified"); // idempotent

    const sent = await submit(slug, { respondentEmail: "attacker@evil.test", emailVerificationId: verificationId });
    expect(sent.status).toBe(200);
    const stored = await ResponseModel.findOne({ formId: form._id });
    expect(stored!.respondentEmail).toBe("bea@example.com"); // from the proof, never from the request
    expect(stored!.respondentEmailVerified).toBe(true);
    expect(mails.map((m) => m.template)).toEqual(["respondent_email_code", "respondent_submission_link"]); // then the signed link, as before

    // single use
    expect((await submit(slug, { emailVerificationId: verificationId })).status).toBe(422);
    expect((await typeCode(slug, verificationId, lastCode())).body.state).toBe("invalid");
  });

  it("guessing is capped: five wrong codes kill the request, even for the right code afterwards", async () => {
    const slug = await publish(await mkForm());
    const { verificationId } = (await ask(slug, "bea@example.com")).body;
    const right = lastCode();
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i += 1) expect((await typeCode(slug, verificationId, wrong)).status).toBe(422);
    const fifth = await typeCode(slug, verificationId, wrong);
    expect(fifth.status).toBe(429);
    expect(fifth.body.state).toBe("locked");
    expect((await typeCode(slug, verificationId, right)).status).toBe(429);
    expect((await submit(slug, { emailVerificationId: verificationId })).status).toBe(422);
  });

  it("only the browser holding the secret can verify: a made-up id or another form's id gets nothing", async () => {
    const a = await publish(await mkForm());
    const b = await publish(await mkForm());
    const { verificationId } = (await ask(a, "bea@example.com")).body;
    const code = lastCode();
    expect((await typeCode(a, "x".repeat(43), code)).status).toBe(404);
    expect((await typeCode(b, verificationId, code)).status).toBe(404); // another form
    await typeCode(a, verificationId, code);
    expect((await submit(b, { emailVerificationId: verificationId })).status).toBe(422);
    expect((await submit(a, {})).status).toBe(422);
    expect((await submit(a, { emailVerificationId: "short" })).status).toBe(422);
  });

  it("an expired code and an expired proof are refused", async () => {
    const slug = await publish(await mkForm());
    const first = (await ask(slug, "bea@example.com")).body.verificationId;
    const code = lastCode();
    await EmailVerification.updateMany({ email: "bea@example.com", verifiedAt: null }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const late = await typeCode(slug, first, code);
    expect(late.status).toBe(410);
    expect(late.body.state).toBe("expired");

    const second = (await ask(slug, "cy@example.com")).body.verificationId;
    await typeCode(slug, second, lastCode());
    await EmailVerification.updateMany({ email: "cy@example.com" }, { $set: { proofExpiresAt: new Date(Date.now() - 1000) } });
    expect((await submit(slug, { emailVerificationId: second })).status).toBe(422);
  });

  it("the secret may also travel in a header", async () => {
    const slug = await publish(await mkForm());
    const { verificationId } = (await ask(slug, "bea@example.com")).body;
    await typeCode(slug, verificationId, lastCode());
    expect((await submit(slug, {}, { "x-email-verification": verificationId })).status).toBe(200);
  });
});

describe("the other way in: a signed-in Beginso account (Google or password)", () => {
  it("a ticket from a signed-in account submits without a code, with the ACCOUNT address, and gets the My-submissions confirmation", async () => {
    const form = await mkForm();
    const slug = await publish(form);
    const ticketRes = await request(app).post(`/api/public/${slug}/submit-ticket`).set({ Authorization: `Bearer ${generateToken({ id: guestAccount._id.toString(), email: guestAccount.email, role: "user" })}` });
    expect(ticketRes.status).toBe(200);
    const ok = await submit(slug, { respondentEmail: "attacker@evil.test" }, { "x-submit-ticket": ticketRes.body.ticket });
    expect(ok.status).toBe(200);
    const stored = await ResponseModel.findOne({ formId: form._id });
    expect(String(stored!.respondentUserId)).toBe(String(guestAccount._id));
    expect(stored!.respondentEmail).toBe("bea@example.com");
    expect(stored!.respondentEmailVerified).toBe(true);
    expect(mails.map((m) => m.template)).toEqual(["respondent_confirmation"]);
  });
});

describe("My submissions", () => {
  it("an account sees the responses whose address was VERIFIED as its own, and never an unverified one", async () => {
    const form = await mkForm();
    const slug = await publish(form);
    const { verificationId } = (await ask(slug, "bea@example.com")).body;
    await typeCode(slug, verificationId, lastCode());
    expect((await submit(slug, { emailVerificationId: verificationId })).status).toBe(200);
    // an old response that merely carries the same text, never verified
    const old = await ResponseModel.create({ formId: form._id, answers: { "Full name": "Old" }, respondentEmail: "bea@example.com", respondentEmailVerified: false, submittedAt: new Date() } as any);
    const verified = (await ResponseModel.findOne({ formId: form._id, respondentEmailVerified: true }))!;

    const mine = (await listMine(guestAccount._id)).map((m) => m.id);
    expect(mine).toContain(String(verified._id));
    expect(mine).not.toContain(String(old._id));
    expect(String((await ResponseModel.findById(verified._id))!.respondentUserId)).toBe(String(guestAccount._id));
    expect((await ResponseModel.findById(old._id))!.respondentUserId ?? null).toBeNull();
    expect(MAX_ATTEMPTS).toBe(5);
  });
});

describe("one gate", () => {
  it("a stored \"login\" mode is the same gate as \"tracked\", and no Email question is needed for either", async () => {
    expect(getAccessMode({ settings: { accessMode: "login" } })).toBe("tracked");
    expect(getAccessMode({ settings: { accessMode: "tracked" } })).toBe("tracked");
    expect(getAccessMode({ settings: { accessMode: "open" } })).toBe("open");
    expect(getAccessMode({ settings: {} })).toBe("open");
    const form = await mkForm({ accessMode: "tracked" });
    expect(evaluateReadiness(form).ready).toBe(true);
    const legacy = await mkForm({ accessMode: "login" });
    const slug = await publish(legacy);
    expect((await ask(slug, "bea@example.com")).status).toBe(200);
  });
});
