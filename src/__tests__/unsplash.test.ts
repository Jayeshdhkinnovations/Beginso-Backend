// Photos from Unsplash for a form's page background and cover: the service (mapping, caching, errors), the routes (who may use them), and the photographer's
// credit that travels with a form. Unsplash itself is faked: no test makes a real request.
jest.mock("firebase-admin/app", () => ({ initializeApp: () => {}, cert: () => {}, getApps: () => [] }));

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import FormStyle from "../models/FormStyle";
import { generateToken } from "../utils/generateToken";
import { clearFeatured, clearUnsplashCache, FEATURED_IDS, featuredPhotos, searchPhotos, toPhoto, trackDownload, UnsplashError } from "../services/unsplash.service";

process.env.JWT_SECRET = "test-jwt-secret-key-for-unsplash";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";
process.env.UNSPLASH_RATE_LIMIT_MAX = "0";

const KEY = "test-access-key-123";

const raw = (id = "abcDEF123", over: any = {}) => ({
  id,
  alt_description: "a soft gradient",
  urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=abc&ixlib=rb-4.1.0`, small: `https://images.unsplash.com/photo-${id}?w=400` },
  user: { name: "Luke Chesser", links: { html: "https://unsplash.com/@lukechesser" } },
  ...over,
});

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
let fetchMock: jest.Mock;

beforeEach(() => {
  process.env.UNSPLASH_ACCESS_KEY = KEY;
  clearUnsplashCache();
  clearFeatured();
  fetchMock = jest.fn();
  (global as any).fetch = fetchMock;
});

describe("toPhoto: one result as the app uses it", () => {
  it("builds the picture address, the preview and the credit with the referral link", () => {
    const p = toPhoto(raw())!;
    expect(p.id).toBe("abcDEF123");
    expect(p.thumb).toBe("https://images.unsplash.com/photo-abcDEF123?w=400");
    const url = new URL(p.url);
    expect(url.hostname).toBe("images.unsplash.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ w: "1920", q: "75", fit: "max", auto: "format", ixid: "abc" });
    expect(p.credit).toEqual({ name: "Luke Chesser", url: "https://unsplash.com/@lukechesser?utm_source=beginso&utm_medium=referral" });
    expect(p.alt).toBe("a soft gradient");
  });

  it.each([
    ["an address on another host", raw("abcDEF123", { urls: { raw: "https://evil.example/x.jpg", small: "https://images.unsplash.com/a" } })],
    ["an address that is not https", raw("abcDEF123", { urls: { raw: "http://images.unsplash.com/x", small: "https://images.unsplash.com/a" } })],
    ["an address with a password", raw("abcDEF123", { urls: { raw: "https://u:p@images.unsplash.com/x", small: "https://images.unsplash.com/a" } })],
    ["a profile on another host", raw("abcDEF123", { user: { name: "A", links: { html: "https://evil.example/@a" } } })],
    ["no photographer name", raw("abcDEF123", { user: { name: "  ", links: { html: "https://unsplash.com/@a" } } })],
    ["an id with odd characters", raw("a b/c<d>12")],
    ["a too short id", raw("abc")],
    ["nothing", null],
    ["a string", "photo"],
  ])("drops a result with %s", (_n, input) => {
    expect(toPhoto(input)).toBeNull();
  });

  it("cleans control characters out of the name and caps its length", () => {
    const p = toPhoto(raw("abcDEF123", { user: { name: `Ana\u0000\u001f${"x".repeat(200)}`, links: { html: "https://unsplash.com/@ana" } } }))!;
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
    expect(p.credit.name).not.toMatch(/[\u0000-\u001f]/);
    expect(p.credit.name.length).toBeLessThanOrEqual(80);
  });
});

describe("searchPhotos", () => {
  it("asks Unsplash with the key in a header only, landscape photos, safe content, and returns the mapped page", async () => {
    fetchMock.mockResolvedValue(reply(200, { total_pages: 7, results: [raw("photoAAAA1"), raw("photoBBBB2"), { junk: true }] }));
    const page = await searchPhotos("  Blue Sky ", 2);
    expect(page.photos.map((p) => p.id)).toEqual(["photoAAAA1", "photoBBBB2"]);
    expect(page).toMatchObject({ page: 2, totalPages: 7 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("https://api.unsplash.com/search/photos?query=Blue%20Sky&page=2&per_page=24&orientation=landscape&content_filter=high");
    expect(url).not.toContain(KEY);
    expect(init.headers.Authorization).toBe(`Client-ID ${KEY}`);
  });

  it("uses the popular feed when there is no search, and reads a plain list", async () => {
    fetchMock.mockResolvedValue(reply(200, [raw("photoAAAA1")]));
    const page = await searchPhotos("   ", 1);
    expect(fetchMock.mock.calls[0][0]).toContain("/photos?page=1&per_page=24&order_by=popular");
    expect(page.photos).toHaveLength(1);
  });

  it("keeps an answer for a while: the same search and page asks Unsplash once, another page asks again", async () => {
    fetchMock.mockResolvedValue(reply(200, { total_pages: 3, results: [raw()] }));
    await searchPhotos("Sky", 1);
    await searchPhotos("sky ", 1); // the same words, in another case
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await searchPhotos("sky", 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failure", async () => {
    fetchMock.mockResolvedValueOnce(reply(500, {})).mockResolvedValueOnce(reply(200, { results: [raw()] }));
    await expect(searchPhotos("sky", 1)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect((await searchPhotos("sky", 1)).photos).toHaveLength(1);
  });

  it.each([
    [403, "BUSY", 429],
    [429, "BUSY", 429],
    [401, "NOT_CONFIGURED", 503],
    [500, "UNAVAILABLE", 503],
    [502, "UNAVAILABLE", 503],
  ])("turns Unsplash's %s into %s (%s) with a plain message", async (status, code, mapped) => {
    fetchMock.mockResolvedValue(reply(status, {}));
    const err = await searchPhotos("sky", 1).catch((e) => e);
    expect(err).toBeInstanceOf(UnsplashError);
    expect(err).toMatchObject({ code, status: mapped });
    expect(err.message).not.toMatch(/unsplash\.com|api|key|403|401/i);
  });

  it("says it is not switched on when there is no key, without asking Unsplash", async () => {
    delete process.env.UNSPLASH_ACCESS_KEY;
    await expect(searchPhotos("sky", 1)).rejects.toMatchObject({ code: "NOT_CONFIGURED", status: 503 });
    process.env.UNSPLASH_ACCESS_KEY = "   ";
    await expect(searchPhotos("sky", 1)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up on a network failure or a slow answer with a plain message", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(searchPhotos("sky", 1)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("caps the pages it reports and survives an answer that is not JSON", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => Promise.reject(new Error("bad json")) });
    expect(await searchPhotos("sky", 1)).toMatchObject({ photos: [], totalPages: 1 });
    clearUnsplashCache();
    fetchMock.mockResolvedValue(reply(200, { total_pages: 99999, results: [] }));
    expect((await searchPhotos("sky", 1)).totalPages).toBe(50);
  });
});

describe("featured photos", () => {
  it("looks each one up once, keeps the list for the day, and asks again when it is cleared", async () => {
    fetchMock.mockImplementation(async (url: string) => reply(200, raw(String(url).split("/photos/")[1])));
    const first = await featuredPhotos();
    expect(first.map((p) => p.id)).toEqual([...FEATURED_IDS]);
    expect(fetchMock).toHaveBeenCalledTimes(FEATURED_IDS.length);
    await featuredPhotos();
    expect(fetchMock).toHaveBeenCalledTimes(FEATURED_IDS.length);
    clearFeatured();
    await featuredPhotos();
    expect(fetchMock).toHaveBeenCalledTimes(FEATURED_IDS.length * 2);
  });

  it("shows the ones it could get when some fail, and asks again for the rest soon", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith(FEATURED_IDS[0]) ? reply(404, {}) : reply(200, raw(String(url).split("/photos/")[1]))));
    const got = await featuredPhotos();
    expect(got).toHaveLength(FEATURED_IDS.length - 1);
    expect(got.map((p) => p.id)).not.toContain(FEATURED_IDS[0]);
  });

  it("says busy when every lookup is turned away, and not switched on without a key", async () => {
    fetchMock.mockResolvedValue(reply(403, {}));
    await expect(featuredPhotos()).rejects.toMatchObject({ code: "BUSY" });
    delete process.env.UNSPLASH_ACCESS_KEY;
    fetchMock.mockClear();
    await expect(featuredPhotos()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("trackDownload", () => {
  it("tells Unsplash for a real id, and never throws", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    await trackDownload("abcDEF123");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.unsplash.com/photos/abcDEF123/download");
    fetchMock.mockRejectedValue(new Error("down"));
    await expect(trackDownload("abcDEF123")).resolves.toBeUndefined();
  });

  it.each(["", "a", "../etc/passwd", "abc def", "abcdef?x=1", "a".repeat(40)])("ignores the id %j", async (id) => {
    await trackDownload(id);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── the routes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let mongoServer: MongoMemoryServer;
let owner: any, editor: any, viewer: any;
let ws: any;
const token = (u: any) => `Bearer ${generateToken({ id: u._id.toString(), email: u.email, role: u.role })}`;
const as = (r: request.Test, u: any) => r.set("Authorization", token(u)).set("x-workspace-id", ws._id.toString());

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const mk = (n: string) => User.create({ firebaseUid: `uid-us-${n}`, fullName: `Us ${n}`, email: `us-${n}@test.com`, status: "active" });
  owner = await mk("owner");
  editor = await mk("editor");
  viewer = await mk("viewer");
  ws = await Workspace.create({ name: "US WS", slug: "us-ws", timezone: "UTC", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  await Membership.create({ userId: editor._id, workspaceId: ws._id, role: "editor" });
  await Membership.create({ userId: viewer._id, workspaceId: ws._id, role: "viewer" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe("GET /api/unsplash/search and /featured", () => {
  it("returns the photos to an editor, and never the key", async () => {
    fetchMock.mockResolvedValue(reply(200, { total_pages: 2, results: [raw("photoAAAA1")] }));
    const res = await as(request(app).get("/api/unsplash/search?q=sky&page=1"), editor);
    expect(res.status).toBe(200);
    expect(res.body.data.photos[0]).toMatchObject({ id: "photoAAAA1", credit: { name: "Luke Chesser" } });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it("returns the featured list", async () => {
    fetchMock.mockImplementation(async (url: string) => reply(200, raw(String(url).split("/photos/")[1])));
    const res = await as(request(app).get("/api/unsplash/featured"), owner);
    expect(res.status).toBe(200);
    expect(res.body.data.photos).toHaveLength(FEATURED_IDS.length);
  });

  it("needs a signed-in person, and a person who can edit forms", async () => {
    expect((await request(app).get("/api/unsplash/search?q=sky")).status).toBe(401);
    expect((await request(app).get("/api/unsplash/featured")).status).toBe(401);
    expect((await request(app).post("/api/unsplash/download").send({ id: "abcDEF123" })).status).toBe(401);
    expect((await as(request(app).get("/api/unsplash/search?q=sky"), viewer)).status).toBe(403);
    expect((await as(request(app).get("/api/unsplash/featured"), viewer)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([["q=" + "x".repeat(81)], ["page=0"], ["page=51"], ["page=abc"], ["page=1.5"], ["page=-3"]])("refuses the query %s", async (query) => {
    const res = await as(request(app).get(`/api/unsplash/search?${query}`), editor);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns away an array or object query instead of crashing", async () => {
    fetchMock.mockResolvedValue(reply(200, { results: [] }));
    const res = await as(request(app).get("/api/unsplash/search?q[]=a&q[]=b&page[x]=1"), editor);
    expect([200, 400]).toContain(res.status);
  });

  it("says busy (429) and not switched on (503) in plain words", async () => {
    fetchMock.mockResolvedValue(reply(403, {}));
    const busy = await as(request(app).get("/api/unsplash/search?q=busy"), editor);
    expect(busy.status).toBe(429);
    expect(busy.body.error.code).toBe("BUSY");
    delete process.env.UNSPLASH_ACCESS_KEY;
    const off = await as(request(app).get("/api/unsplash/search?q=off"), editor);
    expect(off.status).toBe(503);
    expect(off.body.message).toMatch(/not switched on/);
    expect(JSON.stringify(off.body)).not.toMatch(/UNSPLASH_ACCESS_KEY/);
  });
});

describe("POST /api/unsplash/download", () => {
  it("tells Unsplash and answers 204", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    expect((await as(request(app).post("/api/unsplash/download").send({ id: "abcDEF123" }), editor)).status).toBe(204);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.unsplash.com/photos/abcDEF123/download");
  });

  it.each([{}, { id: 5 }, { id: "../x" }, { id: "a b" }, { id: ["abcDEF123"] }, { id: null }])("refuses %j", async (body) => {
    expect((await as(request(app).post("/api/unsplash/download").send(body), editor)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── the credit that travels with a form ──────────────────────────────────────────────────────────────────────────────────────────
describe("theme.credit", () => {
  let formId: string;
  const patch = (theme: unknown) => as(request(app).patch(`/api/forms/${formId}`).send({ branding: { theme } }), editor);
  const ONE = { name: "Luke Chesser", url: "https://unsplash.com/@lukechesser?utm_source=beginso&utm_medium=referral" };
  // one credit for the cover and one for the page background
  const CREDIT = { cover: ONE, background: { name: "Ana Diaz", url: "https://unsplash.com/@ana?utm_source=beginso&utm_medium=referral" } };

  beforeAll(async () => {
    const created = await as(request(app).post("/api/forms").send({ title: "Credit form", fields: [{ label: "A", type: "short_text", required: false }] }), owner);
    formId = created.body.form._id;
  });

  it("is stored and returned by the public read", async () => {
    expect((await patch({ v: 1, credit: CREDIT })).status).toBe(200);
    const published = await as(request(app).post(`/api/forms/${formId}/publish`), owner);
    const pub = await request(app).get(`/api/public/${published.body.slug}`);
    expect((pub.body.form ?? pub.body).branding.theme.credit).toEqual(CREDIT);
  });

  it.each([
    ["a profile without a name part", "https://unsplash.com/"],
    ["a photo page", "https://unsplash.com/photos/abc"],
    ["another host", "https://evil.example/@a"],
    ["a look-alike host", "https://unsplash.com.evil.example/@a"],
    ["a host with a password", "https://u:p@unsplash.com/@a"],
    ["http", "http://unsplash.com/@a"],
    ["javascript", "javascript:alert(1)"],
    ["a quote in the query", 'https://unsplash.com/@a?x="onmouseover=1'],
    ["a space", "https://unsplash.com/@a b"],
    ["too long", "https://unsplash.com/@" + "a".repeat(300)],
  ])("refuses %s as the address", async (_n, url) => {
    const res = await patch({ v: 1, credit: { cover: { ...ONE, url } } });
    // the bare site address is allowed (a profile part is optional); everything else here is refused
    expect(res.status).toBe(url === "https://unsplash.com/" ? 200 : 400);
  });

  it.each([
    ["no name", { cover: { ...ONE, name: "" } }],
    ["a spaces-only name", { cover: { ...ONE, name: "   " } }],
    ["a long name", { background: { ...ONE, name: "x".repeat(81) } }],
    ["markup in the name", { cover: { ...ONE, name: "<script>x</script>" } }],
    ["a control character", { cover: { ...ONE, name: "A\u0000B" } }],
    ["a name that is not text", { cover: { ...ONE, name: 5 } }],
    ["one credit that is not an object", { cover: "Luke" }],
    ["credit as a string", "Luke"],
    ["credit as a list", []],
  ])("refuses %s", async (_n, credit) => {
    expect((await patch({ v: 1, credit })).status).toBe(400);
  });

  it("is dropped from a saved style: a style never keeps a photo, so it keeps no credit", async () => {
    await FormStyle.deleteMany({});
    const res = await as(request(app).post("/api/form-styles").send({ name: "With credit", layout: "classic", branding: { primaryColor: "#112233", theme: { v: 1, credit: CREDIT, card: { radius: 8 } } } }), editor);
    expect(res.status).toBe(201);
    expect(res.body.data.branding.theme).toEqual({ v: 1, card: { radius: 8 } });
    const only = await as(request(app).post("/api/form-styles").send({ name: "Only credit", layout: "classic", branding: { theme: { v: 1, credit: CREDIT } } }), editor);
    expect(only.status).toBe(201);
    expect(only.body.data.branding.theme).toBeUndefined();
  });

  it("is kept when the form is duplicated (the copy still shows the photo)", async () => {
    expect((await patch({ v: 1, credit: CREDIT })).status).toBe(200);
    const copy = await as(request(app).post(`/api/forms/${formId}/duplicate`), owner);
    expect(copy.status).toBe(201);
    const stored = await Form.findById((copy.body.data ?? copy.body.form ?? copy.body)._id).lean();
    expect((stored as any).branding.theme.credit).toEqual(CREDIT);
  });
});
