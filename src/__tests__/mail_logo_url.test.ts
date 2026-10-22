// The logo at the top of every mail is the hosted light SVG, with the hosted dark SVG swapped in for readers in dark mode.
const load = (env: Record<string, string | undefined>) => {
  const keys = ["EMAIL_LOGO_URL", "EMAIL_LOGO_DARK_URL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  let mod: typeof import("../mail/layout");
  jest.isolateModules(() => {
    mod = require("../mail/layout");
  });
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return mod!;
};

describe("mail logo", () => {
  it("defaults to the hosted full logo (icon and wordmark), light and dark", () => {
    const m = load({});
    expect(m.LOGO_URL).toBe("https://storage.beginso.com/assets/logo-full-light.svg");
    expect(m.LOGO_DARK_URL).toBe("https://storage.beginso.com/assets/logo-full-dark.svg");
  });

  it("can be overridden by env", () => {
    const m = load({ EMAIL_LOGO_URL: "https://cdn.example.com/l.svg", EMAIL_LOGO_DARK_URL: "https://cdn.example.com/d.svg" });
    expect(m.LOGO_URL).toBe("https://cdn.example.com/l.svg");
    expect(m.LOGO_DARK_URL).toBe("https://cdn.example.com/d.svg");
  });

  it("renders both logos, hides the dark one by default and swaps on prefers-color-scheme: dark", () => {
    const { renderMail } = require("../services/mail.service");
    const html: string = renderMail({ to: "a@b.test", template: "reset_password", name: "Ann", link: "https://www.beginso.com/reset" })!.html;
    expect(html).toContain('class="logo-light" src="https://storage.beginso.com/assets/logo-full-light.svg"');
    expect(html).toContain('class="logo-dark" src="https://storage.beginso.com/assets/logo-full-dark.svg"');
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain('content="light dark"');
  });
});
