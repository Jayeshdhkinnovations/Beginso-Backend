// Who each mail comes from: no-reply for codes, registration and account notices; notifications for form submissions and workflow alerts; support for
// support emails. Replies to all of them go to SMTP_REPLY_TO (no-reply@beginso.com unless set).

const sendMail = jest.fn().mockResolvedValue({ messageId: "m" });
jest.mock("nodemailer", () => ({ __esModule: true, default: { createTransport: () => ({ sendMail }) } }));
jest.mock("../models/MailLog", () => ({ recordMailLog: jest.fn().mockResolvedValue(undefined) }));

import { mailService, senderFor, type AuthMailType } from "../services/mail.service";

const KEYS = ["SMTP_FROM_NAME", "SMTP_FROM_EMAIL", "SMTP_USER", "SMTP_FROM_EMAIL_NOTIFICATIONS", "SMTP_FROM_EMAIL_SUPPORT", "SMTP_FROM_NAME_SUPPORT", "SMTP_FROM_NAME_NOTIFICATIONS", "SMTP_REPLY_TO", "MAIL_DOMAIN"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  sendMail.mockClear();
});
afterEach(() => {
  for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
});

describe("senderFor", () => {
  it.each<[AuthMailType, string]>([
    ["verify_email_otp", "no-reply@beginso.com"],
    ["verify_email", "no-reply@beginso.com"],
    ["reset_password", "no-reply@beginso.com"],
    ["welcome_user", "no-reply@beginso.com"],
    ["new_device_signin", "no-reply@beginso.com"],
    ["workspace_invitation", "no-reply@beginso.com"],
    ["respondent_email_code", "no-reply@beginso.com"],
    ["activity_notification", "notifications@beginso.com"],
    ["respondent_receipt", "notifications@beginso.com"],
    ["respondent_confirmation", "notifications@beginso.com"],
    ["response_limit_reached", "notifications@beginso.com"],
    ["export_ready", "no-reply@beginso.com"],
    ["storage_warning", "no-reply@beginso.com"],
    ["role_changed", "no-reply@beginso.com"],
    ["weekly_digest", "notifications@beginso.com"],
  ])("%s comes from %s", (template, email) => {
    expect(senderFor({ template }).email).toBe(email);
  });

  it("support comes from support@beginso.com only when asked for", () => {
    expect(senderFor({ template: "welcome_user", sender: "support" })).toEqual({ name: "Beginso Support", email: "support@beginso.com" });
  });

  it("SMTP_FROM_EMAIL still sets the no-reply address, and each other address can be set on its own", () => {
    process.env.SMTP_FROM_EMAIL = "noreply@example.test";
    process.env.SMTP_FROM_EMAIL_NOTIFICATIONS = "alerts@example.test";
    process.env.SMTP_FROM_EMAIL_SUPPORT = "help@example.test";
    expect(senderFor({ template: "reset_password" }).email).toBe("noreply@example.test");
    expect(senderFor({ template: "activity_notification" }).email).toBe("alerts@example.test");
    expect(senderFor({ template: "reset_password", sender: "support" }).email).toBe("help@example.test");
  });
});

describe("sendMail", () => {
  it("sends a sign-in code from no-reply and a form alert from notifications, both with replies to no-reply", async () => {
    await mailService.sendMail({ to: "a@example.test", template: "reset_password", actionUrl: "https://beginso.com/reset?t=1" });
    await mailService.sendMail({
      to: "b@example.test",
      template: "response_limit_reached",
      payload: { formName: "Survey", formId: "f1", reason: "limit", limit: 10, totalResponses: 10, closedAt: new Date(), unsubscribeUrl: "https://beginso.com/u" } as never,
    });
    const [reset, alert] = sendMail.mock.calls.map((c) => c[0]);
    expect(reset.from).toBe('"Beginso" <no-reply@beginso.com>');
    expect(alert.from).toBe('"Beginso" <notifications@beginso.com>');
    expect(reset.replyTo).toBe("no-reply@beginso.com");
    expect(alert.replyTo).toBe("no-reply@beginso.com");
  });

  it("sends from support when the caller says so", async () => {
    await mailService.sendMail({ to: "a@example.test", template: "welcome_user", sender: "support" });
    expect(sendMail.mock.calls[0][0].from).toBe('"Beginso Support" <support@beginso.com>');
  });
});
