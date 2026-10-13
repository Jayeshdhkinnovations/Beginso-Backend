// Where a response came from: a coarse location looked up from the submitter's IP at submit time (offline database),
// never stored as an address, never returned per response, and shown only as groups on the dashboard.
process.env.JWT_SECRET = "test-jwt-secret-key-for-response-location";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";
process.env.PROXY_SHARED_SECRET = "response-location-proxy-secret";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import ResponseModel from "../models/Response";
import { generateToken } from "../utils/generateToken";
import { lookupGeo } from "../utils/geo";

describe("lookupGeo", () => {
  it("returns nothing for private, loopback, empty and unknown addresses", () => {
    for (const ip of [null, undefined, "", "unknown", "127.0.0.1", "10.0.0.8", "192.168.1.20", "::1", "::ffff:127.0.0.1", "not-an-ip"]) {
      expect(lookupGeo(ip as any)).toBeNull();
    }
  });

  it("returns a country and a position rounded to two decimals for a public address", () => {
    const g = lookupGeo("8.8.8.8");
    expect(g).not.toBeNull();
    expect(typeof g!.country).toBe("string");
    expect(g!.country.length).toBeGreaterThan(0);
    for (const n of [g!.lat, g!.lng]) {
      expect(Number.isFinite(n)).toBe(true);
      expect(Math.round(n * 100) / 100).toBe(n);
    }
  });

  it("reads an IPv4-mapped IPv6 address the same as the plain one", () => {
    expect(lookupGeo("::ffff:8.8.8.8")).toEqual(lookupGeo("8.8.8.8"));
  });
});

describe("capturing and reporting locations", () => {
  let mongoServer: MongoMemoryServer;
  let tOwner: string;
  let slugWs: string;
  let publicSlug: string;

  const headers = () => ({ Authorization: `Bearer ${tOwner}`, "x-workspace-slug": slugWs });
  const submit = (extra: Record<string, string> = {}) =>
    request(app)
      .post(`/api/public/${publicSlug}/submit`)
      .set(extra)
      .field("data", JSON.stringify({ Name: "Alice" }));
  // the proxy forwards the visitor's address together with a shared secret; without the secret the header is ignored
  const fromIp = (ip: string) => ({ "x-client-ip": ip, "x-proxy-secret": process.env.PROXY_SHARED_SECRET as string });

  beforeAll(async () => {
    await mongoose.disconnect();
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    const owner = await User.create({ firebaseUid: "uid-geo-owner", fullName: "Owner", email: "owner@geo.test", status: "active" });
    const ws = await Workspace.create({ name: "Geo Workspace", owner: owner._id });
    await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
    tOwner = generateToken({ id: owner._id.toString(), email: owner.email, role: "user" });
    slugWs = ws.slug;

    const created = await request(app)
      .post("/api/forms")
      .set(headers())
      .send({ title: "Geo form", fields: [{ label: "Name", type: "short_text", required: false }] });
    expect(created.status).toBe(201);
    const published = await request(app).post(`/api/forms/${created.body.form._id}/publish`).set(headers());
    expect(published.status).toBe(200);
    publicSlug = published.body.slug;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await ResponseModel.deleteMany({});
  });

  it("stores a coarse location for a trusted public address and no address at all", async () => {
    const res = await submit(fromIp("8.8.8.8"));
    expect(res.status).toBe(200);
    const stored: any = await ResponseModel.findById(res.body.submission._id).lean();
    expect(stored.geo.country).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain("8.8.8.8");
  });

  it("never echoes the location back to the respondent", async () => {
    const res = await submit(fromIp("8.8.8.8"));
    expect(res.body.submission.geo).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/"geo"/);
  });

  it("records no location for a local address or an untrusted forwarded header", async () => {
    const local = await submit();
    const spoofed = await submit({ "x-client-ip": "8.8.8.8" }); // header without the shared secret is ignored
    for (const r of [local, spoofed]) {
      expect(r.status).toBe(200);
      expect(((await ResponseModel.findById(r.body.submission._id).lean()) as any).geo).toBeUndefined();
    }
  });

  it("does not return the location in the response detail either", async () => {
    const res = await submit(fromIp("8.8.8.8"));
    const detail = await request(app).get(`/api/responses/${res.body.submission._id}`).set(headers());
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/"geo"|"lat"|"lng"/);
  });

  it("shows locations on the dashboard only as groups with a count, and counts the unlocated separately", async () => {
    await submit(fromIp("8.8.8.8"));
    await submit(fromIp("8.8.8.8"));
    await submit(); // no location
    const res = await request(app).get("/api/dashboard/analytics").set(headers());
    expect(res.status).toBe(200);
    const a = res.body.analytics;
    expect(a.totalResponses).toBe(3);
    expect(a.locatedResponses).toBe(2);
    expect(a.locations).toHaveLength(1);
    expect(a.locations[0]).toMatchObject({ count: 2 });
    expect(typeof a.locations[0].country).toBe("string");
    expect(Number.isFinite(a.locations[0].lat)).toBe(true);
    expect(JSON.stringify(a.locations)).not.toContain("8.8.8.8");
  });
});
