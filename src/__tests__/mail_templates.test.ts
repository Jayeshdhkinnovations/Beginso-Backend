import { renderMail, SendMailOptions } from "../services/mail.service";
import { renderWorkspaceDeletedEmail, renderExportReadyEmail, renderInvitationReminderEmail } from "../mail/templates";

const legacy: SendMailOptions["template"][] = [
  "verify_email", "reset_password", "welcome_user", "workspace_invitation",
  "email_verified_success", "password_changed_success",
];

describe("mail templates", () => {
  it.each(legacy)("%s renders a complete, branded email", (template) => {
    const m = renderMail({ to: "a@b.test", template, name: "Ann", workspaceName: "Smith & Co <x>", inviterName: "Bo" })!;
    expect(m.subject).toBeTruthy();
    expect(m.text).not.toMatch(/undefined|NaN/);
    expect(m.html).toMatch(/^<!DOCTYPE html>/);
    expect(m.html).toContain("https://storage.beginso.com/assets/logo-full-light.png");
    expect(m.html).not.toContain(".svg");
    expect(m.html).not.toContain("#2563EB");
    expect(m.subject).not.toMatch(/[\u{1F300}-\u{1FAFF}✅✉]/u);
  });

  it("escapes dynamic values", () => {
    const m = renderMail({ to: "a@b.test", template: "workspace_invitation", workspaceName: "Smith & Co <b>", inviterName: "Bo" })!;
    expect(m.html).toContain("Smith &amp; Co &lt;b&gt;");
    expect(m.html).not.toContain("<b>Smith");
  });

  it("refuses an unknown template or a missing payload instead of sending blank mail", () => {
    expect(renderMail({ to: "a@b.test", template: "nope" as any })).toBeNull();
    expect(renderMail({ to: "a@b.test", template: "export_ready" })).toBeNull();
    expect(renderMail({ to: "a@b.test", template: "activity_notification" })).toBeNull();
  });

  it("does not double-escape the preheader", () => {
    const m = renderInvitationReminderEmail({
      workspaceName: "W", inviterName: "Smith & Co", role: "viewer", acceptUrl: "https://x.test/a",
      expiresAt: new Date(Date.now() + 3 * 864e5), invitedEmail: "a@b.test",
    });
    expect(m.html).not.toContain("&amp;amp;");
  });

  it("export and deletion emails carry real numbers", () => {
    const e = renderExportReadyEmail({ format: "PDF", rowCount: 1, downloadUrl: "https://x.test/d", expiresAt: new Date(Date.now() + 864e5) });
    expect(e.subject).toBe("Your PDF export is ready");
    expect(renderWorkspaceDeletedEmail({ workspaceName: "W", deletedByName: "Bo", deletedAt: new Date(), formCount: 2, responseCount: 9, memberCount: 3 }).text).toContain("9 responses");
  });
});
