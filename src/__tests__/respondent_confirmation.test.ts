// The confirmation mail for "signed-in Beginso users only" forms: no answers, and a link that needs a sign-in (not the tracked-mode token).
import { renderRespondentConfirmationEmail } from "../mail/templates";
import { renderMail, mailService } from "../services/mail.service";
import { sendSubmissionConfirmation } from "../services/respondent.service";

const URL_ = "https://www.beginso.com/my-submissions";

describe("renderRespondentConfirmationEmail", () => {
  const mail = renderRespondentConfirmationEmail({ formName: "Customer <feedback>", myUrl: URL_ });

  it("names the form (escaped) and points at My submissions", () => {
    expect(mail.subject).toBe('We received your response to "Customer <feedback>"');
    expect(mail.html).toContain("Customer &lt;feedback&gt;");
    expect(mail.html).toContain(`href="${URL_}"`);
    expect(mail.text).toContain(URL_);
  });

  it("holds no token: the link is a plain signed-in page, never the /r/<token> link of tracked mode", () => {
    for (const body of [mail.html, mail.text]) {
      expect(body).not.toMatch(/\/r\/[A-Za-z0-9_-]{10,}/);
      expect(body).not.toMatch(/token|oobCode|ticket/i);
    }
    expect(new URL(URL_).pathname).toBe("/my-submissions");
  });

  it("tells the person they will be asked to sign in, and never repeats what they submitted", () => {
    expect(mail.text).toMatch(/asked to sign in/);
    expect(mail.text).toMatch(/does not repeat what you submitted/);
  });

  it("renders through the mail service for the new template, and refuses to send without a payload", () => {
    const rendered = renderMail({ to: "a@b.test", template: "respondent_confirmation", payload: { formName: "F", myUrl: URL_ } });
    expect(rendered?.html).toContain(URL_);
    expect(renderMail({ to: "a@b.test", template: "respondent_confirmation" })).toBeNull();
  });
});

describe("sendSubmissionConfirmation", () => {
  it("sends the confirmation template with the form name and the My submissions address, and nothing else", async () => {
    const spy = jest.spyOn(mailService, "sendMail").mockResolvedValue(true);
    await sendSubmissionConfirmation({ formName: "Event signup", email: "cy@x.com" });
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0] as any;
    expect(arg).toMatchObject({ to: "cy@x.com", template: "respondent_confirmation" });
    expect(arg.payload.formName).toBe("Event signup");
    expect(arg.payload.myUrl).toMatch(/\/my-submissions$/);
    expect(Object.keys(arg.payload).sort()).toEqual(["formName", "myUrl"]);
    spy.mockRestore();
  });

  it("never throws when the mail service does", async () => {
    const spy = jest.spyOn(mailService, "sendMail").mockRejectedValue(new Error("smtp down"));
    await expect(sendSubmissionConfirmation({ formName: "F", email: "a@b.test" })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
