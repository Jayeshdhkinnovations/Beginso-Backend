// Link preview for a respondent-supplied URL (GET /api/responses/link-preview). The fetch runs from our network on
// untrusted input, so these tests pin what it must refuse (private addresses, odd schemes, credentials, ports) and
// how it reads a page. Nothing here touches the real network.
process.env.JWT_SECRET = "test-jwt-secret-key-for-link-preview";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";
process.env.LINK_PREVIEW_RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import { generateToken } from "../utils/generateToken";
import { getLinkPreview, isPrivateIp, parsePreview } from "../services/linkPreview.service";

describe("isPrivateIp", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1",
    "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1",
  ])("treats %s as private", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("treats %s as public", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it("refuses anything that is not an IP address it understands", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
  });
});

describe("getLinkPreview refuses unsafe addresses without fetching", () => {
  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://example.com/file",
    "data:text/html,<h1>x</h1>",
    "http://127.0.0.1/",
    "http://10.0.0.5/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://user:secret@example.com/",
    "http://example.com:8080/",
    "https://example.com:8443/",
    "not a url",
    "",
  ])("returns null for %s", async (url) => {
    expect(await getLinkPreview(url)).toBeNull();
  });

  it("gives only the link and domain when a host name resolves to a private address", async () => {
    // "localhost" passes the first check (it is not an IP literal) and is refused again at connect time.
    const res = await getLinkPreview("http://localhost/some/page");
    expect(res).toEqual({ url: "http://localhost/some/page", domain: "localhost" });
  });
});

describe("parsePreview", () => {
  const final = new URL("https://www.example.com/post/1");

  it("prefers the Open Graph title, site name and image", () => {
    const html = `<html><head><title>Plain title</title>
      <meta property="og:title" content="OG &amp; title"><meta property="og:site_name" content="Example">
      <meta property="og:image" content="/img/cover.png"></head></html>`;
    expect(parsePreview(html, final)).toEqual({ title: "OG & title", siteName: "Example", image: "https://www.example.com/img/cover.png" });
  });

  it("falls back to the <title> tag and drops a non-https image (it would be blocked as mixed content)", () => {
    const html = `<title>  Just a page </title><meta property="og:image" content="http://cdn.example.com/a.png">`;
    const out = parsePreview(html, final);
    expect(out.title).toBe("Just a page");
    expect(out.image).toBeUndefined();
  });

  it("returns nothing for a page with no metadata", () => {
    expect(parsePreview("<html><body>hello</body></html>", final)).toEqual({});
  });

  it("caps the title length", () => {
    const out = parsePreview(`<title>${"x".repeat(500)}</title>`, final);
    expect(out.title!.length).toBeLessThanOrEqual(200);
  });
});

describe("GET /api/responses/link-preview", () => {
  let mongoServer: MongoMemoryServer;
  let tEditor: string;
  let wsSlug: string;

  beforeAll(async () => {
    await mongoose.disconnect();
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    const editor = await User.create({ firebaseUid: "uid-lp-editor", fullName: "E", email: "editor@lp.test", status: "active" });
    const ws = await Workspace.create({ name: "LP Workspace", owner: editor._id });
    await Membership.create({ userId: editor._id, workspaceId: ws._id, role: "editor" });
    tEditor = generateToken({ id: editor._id.toString(), email: editor.email, role: "user" });
    wsSlug = ws.slug;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const call = (url: string | undefined, tok: string | null = tEditor) => {
    const r = request(app).get("/api/responses/link-preview").query(url === undefined ? {} : { url });
    return tok ? r.set({ Authorization: `Bearer ${tok}`, "x-workspace-slug": wsSlug }) : r;
  };

  it("needs a session", async () => {
    expect((await call("https://example.com", null)).status).toBe(401);
  });

  it("answers 422 for a missing, unsafe, private or over-long address", async () => {
    expect((await call(undefined)).status).toBe(422);
    expect((await call("javascript:alert(1)")).status).toBe(422);
    expect((await call("http://127.0.0.1/")).status).toBe(422);
    expect((await call("http://user:pw@example.com/")).status).toBe(422);
    expect((await call("https://example.com/" + "a".repeat(2100))).status).toBe(422);
  });

  it("answers 200 with at least the link and domain even when the site cannot be read", async () => {
    const res = await call("http://localhost/page");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preview).toEqual({ url: "http://localhost/page", domain: "localhost" });
  });
});
