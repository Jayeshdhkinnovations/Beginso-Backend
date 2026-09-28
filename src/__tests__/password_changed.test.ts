import request from "supertest";
import app from "../app";
import { mailService } from "../services/mail.service";
import User from "../models/User";

jest.mock("../services/mail.service", () => ({
  mailService: {
    sendMail: jest.fn().mockResolvedValue({ messageId: "test-msg-id" }),
  },
}));

jest.mock("firebase-admin/auth", () => {
  const authMock = { updateUser: jest.fn(), getUserByEmail: jest.fn() };
  return { getAuth: () => authMock };
});

const { getAuth } = jest.requireMock("firebase-admin/auth");
const mockUpdateUser = getAuth().updateUser;
const mockGetUserByEmail = getAuth().getUserByEmail;

describe("Password Changed Success Email Endpoints", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // resetMocks (jest.config) strips the factory's mockResolvedValue before every test.
    (mailService.sendMail as jest.Mock).mockResolvedValue({ messageId: "test-msg-id" });
    // No database in this suite: without this the handler waits 10s for a mongoose connection.
    jest.spyOn(User, "findOne").mockResolvedValue(null as any);
  });

  it("must never set a password on /api/auth/confirm-password-reset", async () => {
    await request(app)
      .post("/api/auth/confirm-password-reset")
      .send({ email: "victim@beginso.com", newPassword: "attacker-chosen-1" });

    expect(mockGetUserByEmail).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("does not expose /api/test routes", async () => {
    const res = await request(app).post("/api/test/create-user");
    expect(res.status).toBe(404);
  });

  it("should return 400 on /api/auth/confirm-password-reset when missing oobCode or newPassword", async () => {
    const res = await request(app)
      .post("/api/auth/confirm-password-reset")
      .send({ oobCode: "" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("should return 400 on /api/auth/password-changed when missing email", async () => {
    const res = await request(app)
      .post("/api/auth/password-changed")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("should successfully trigger password_changed_success email on /api/auth/password-changed with valid email", async () => {
    const res = await request(app)
      .post("/api/auth/password-changed")
      .send({ email: "user@beginso.com" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mailService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@beginso.com",
        template: "password_changed_success",
      })
    );
  });
});
