import fs from "fs";
import os from "os";
import path from "path";
import { FormService } from "../services/form.service";
import { isPrivateIp, parsePreview } from "../services/linkPreview.service";
import { looksLikeImage } from "../utils/imageUpload";

// Pure checks for the V2 field types (no database): answer validation, the link-preview SSRF guard and the
// image magic-byte check.
const service = new FormService();
const field = (type: string, extra: Record<string, unknown> = {}) => ({ fieldId: `f_${type}`, label: type, type, required: true, ...extra });
const check = (f: any, value: unknown) => service.validateAnswers({ fields: [f] } as any, { [f.label]: value });

describe("V2 field answers", () => {
  it("rating must be an integer 1-5", () => {
    expect(() => check(field("rating"), 4)).not.toThrow();
    expect(() => check(field("rating"), 6)).toThrow();
    expect(() => check(field("rating"), 2.5)).toThrow();
  });

  it("url must be http(s)", () => {
    expect(() => check(field("url"), "https://example.com/a?b=1")).not.toThrow();
    expect(() => check(field("url"), "javascript:alert(1)")).toThrow();
    expect(() => check(field("url"), "not a url")).toThrow();
  });

  it("time, datetime, yes_no and currency", () => {
    expect(() => check(field("time"), "14:30")).not.toThrow();
    expect(() => check(field("time"), "25:00")).toThrow();
    expect(() => check(field("datetime"), "2026-09-25T10:30")).not.toThrow();
    expect(() => check(field("datetime"), "2026-09-25")).toThrow();
    expect(() => check(field("yes_no"), "Yes")).not.toThrow();
    expect(() => check(field("yes_no"), "Maybe")).toThrow();
    expect(() => check(field("currency", { min: 10 }), 50000)).not.toThrow();
    expect(() => check(field("currency", { min: 10 }), 5)).toThrow();
  });

  it("signature is a PNG data URL or short typed text, nothing else", () => {
    expect(() => check(field("signature"), "data:image/png;base64,iVBORw0KGgo=")).not.toThrow();
    expect(() => check(field("signature"), "Priya Sharma")).not.toThrow();
    expect(() => check(field("signature"), "data:text/html;base64,PHNjcmlwdD4=")).toThrow();
  });

  it("image_upload is a list of stored names, capped by the field's settings", () => {
    expect(() => check(field("image_upload"), ["a.png"])).not.toThrow();
    expect(() => check(field("image_upload"), ["a.png", "b.png"])).toThrow(); // single by default
    expect(() => check(field("image_upload", { allowMultiple: true, maxImages: 2 }), ["a.png", "b.png"])).not.toThrow();
    expect(() => check(field("image_upload", { allowMultiple: true, maxImages: 2 }), ["a", "b", "c"])).toThrow();
    expect(() => check(field("image_upload"), [])).toThrow(); // required
  });
});

describe("link preview safety", () => {
  it("refuses private, loopback and link-local addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });

  it("reads title and an https thumbnail, ignores http images", () => {
    const html = '<head><title>Ignored</title><meta property="og:title" content="Event &amp; Co"><meta property="og:image" content="/banner.png"></head>';
    expect(parsePreview(html, new URL("https://example.com/x"))).toEqual({ title: "Event & Co", image: "https://example.com/banner.png" });
    const insecure = '<meta property="og:image" content="http://example.com/b.png">';
    expect(parsePreview(insecure, new URL("https://example.com")).image).toBeUndefined();
  });
});

describe("image magic bytes", () => {
  it("accepts a PNG header and rejects text renamed to .png", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));
    const png = path.join(dir, "a.png");
    const fake = path.join(dir, "b.png");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    fs.writeFileSync(fake, "<html><script>alert(1)</script></html>");
    expect(looksLikeImage(png)).toBe(true);
    expect(looksLikeImage(fake)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
