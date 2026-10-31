// POST /api/auth/password-changed sends the "your password was changed" email to the SIGNED-IN user's own address only.
// The address never comes from the request body, and the old alias /api/auth/notify-password-changed is gone.
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app";
import User from "../models/User";
import { generateToken } from "../utils/generateToken";
import { mailService } from "../services/mail.service";

jest.mock("../services/mail.service", () => ({
  mailService: {
    sendMail: jest.fn().mockResolvedValue({ messageId: "test-msg-id" }),
  },
}));

let mongoServer: MongoMemoryServer;
let token: string;

beforeAll(async () => {
  process.env.JWT_SECRET = "testsecret";
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const user = await User.create({ firebaseUid: "pwd-uid", fullName: "Pwd User", email: "Pwd.User@Test.com", role: "admin" });
  token = generateToken({ id: String(user._id), email: user.email, role: user.role });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

beforeEach(() => {
  // resetMocks (jest.config) strips the factory's mockResolvedValue before every test.
  (mailService.sendMail as jest.Mock).mockResolvedValue({ messageId: "test-msg-id" });
});

const SUCCESS = { success: true, message: "Password changed confirmation email sent." };

describe("POST /api/auth/password-changed", () => {
  it("with no session and an email in the body: answers success and sends nothing", async () => {
    const res = await request(app).post("/api/auth/password-changed").send({ email: "victim@beginso.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUCCESS);
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it("with no session and no body: the same success answer, nothing sent", async () => {
    const res = await request(app).post("/api/auth/password-changed").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUCCESS);
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it("with an invalid token: the same success answer, nothing sent", async () => {
    const res = await request(app)
      .post("/api/auth/password-changed")
      .set("Authorization", "Bearer not-a-real-token")
      .send({ email: "victim@beginso.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUCCESS);
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it("with a valid session: sends to the session's own address", async () => {
    const res = await request(app).post("/api/auth/password-changed").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUCCESS);
    expect(mailService.sendMail).toHaveBeenCalledTimes(1);
    expect(mailService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "pwd.user@test.com", template: "password_changed_success" })
    );
  });

  it("with a valid session and somebody else's address in the body: still only the session's own address", async () => {
    await request(app).post("/api/auth/password-changed").set("Authorization", `Bearer ${token}`).send({ email: "victim@beginso.com" });
    expect(mailService.sendMail).toHaveBeenCalledTimes(1);
    const arg = (mailService.sendMail as jest.Mock).mock.calls[0][0];
    expect(arg.to).toBe("pwd.user@test.com");
    expect(JSON.stringify(arg)).not.toContain("victim@beginso.com");
  });
});

describe("the old alias is gone", () => {
  it("POST /api/auth/notify-password-changed is a 404, with or without a session", async () => {
    expect((await request(app).post("/api/auth/notify-password-changed").send({ email: "victim@beginso.com" })).status).toBe(404);
    expect((await request(app).post("/api/auth/notify-password-changed").set("Authorization", `Bearer ${token}`).send({})).status).toBe(404);
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });
});
