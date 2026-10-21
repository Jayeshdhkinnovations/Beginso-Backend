import { formMark } from "../utils/formMark";

describe("formMark", () => {
  it("returns the logo and the icon of a form, null for what is missing or empty", () => {
    expect(formMark({ branding: { logoUrl: "https://x/y.png", iconName: "star" } })).toEqual({ logoUrl: "https://x/y.png", iconName: "star" });
    expect(formMark({ branding: { logoUrl: "", iconName: undefined } })).toEqual({ logoUrl: null, iconName: null });
    expect(formMark({ branding: null })).toEqual({ logoUrl: null, iconName: null });
    expect(formMark({})).toEqual({ logoUrl: null, iconName: null });
  });
});
