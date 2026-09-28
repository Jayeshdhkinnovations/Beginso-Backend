import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import { generateToken } from "../utils/generateToken";
import { isPrivateOrInvalidIp, resolveIpLocation } from "../services/geolocation.service";

let mongoServer: MongoMemoryServer;
let superAdminToken: string;
let adminUser: any;

process.env.JWT_SECRET = "test-secret-key-1234567890-test-key-long-enough";

beforeAll(async () => {
  await mongoose.disconnect();
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  const superUser = await User.create({
    firebaseUid: "super-geo-uid",
    fullName: "Super Admin Geo",
    email: "superadmin-geo@test.com",
    role: "super_admin",
    status: "active",
  });
  superAdminToken = generateToken({ id: superUser._id.toString(), email: superUser.email, role: superUser.role });

  adminUser = await User.create({
    firebaseUid: "admin-geo-uid",
    fullName: "Admin Geo",
    email: "admin-geo@test.com",
    role: "admin",
    status: "active",
    loginHistory: [
      {
        timestamp: new Date(),
        ip: "103.42.193.24",
        userAgent: "Mozilla/5.0",
        location: {
          city: "Mumbai",
          region: "Maharashtra",
          country: "India",
          latitude: 19.076,
          longitude: 72.8777,
        },
      },
      {
        timestamp: new Date(Date.now() - 3600000),
        ip: "127.0.0.1",
        userAgent: "Localhost",
        location: null,
      },
    ],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe("IP Geolocation Resolution & Super Admin Integration", () => {
  it("should filter out private and loopback IP addresses", () => {
    expect(isPrivateOrInvalidIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrInvalidIp("::1")).toBe(true);
    expect(isPrivateOrInvalidIp("10.0.1.50")).toBe(true);
    expect(isPrivateOrInvalidIp("192.168.1.100")).toBe(true);
    expect(isPrivateOrInvalidIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrInvalidIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrInvalidIp("unknown")).toBe(true);
    expect(isPrivateOrInvalidIp("")).toBe(true);

    expect(isPrivateOrInvalidIp("103.42.193.24")).toBe(false);
    expect(isPrivateOrInvalidIp("8.8.8.8")).toBe(false);
  });

  it("should return null for private IP geolocation resolution without network calls", async () => {
    const loc = await resolveIpLocation("127.0.0.1");
    expect(loc).toBeNull();
  });

  it("should include resolved location object on GET /api/superadmin/admins/:id loginHistory array", async () => {
    const res = await request(app)
      .get(`/api/superadmin/admins/${adminUser._id}`)
      .set("Authorization", `Bearer ${superAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.loginHistory).toBeDefined();
    expect(Array.isArray(res.body.loginHistory)).toBe(true);
    expect(res.body.loginHistory.length).toBe(2);

    const publicEntry = res.body.loginHistory.find((e: any) => e.ip === "103.42.193.24");
    expect(publicEntry).toBeDefined();
    expect(publicEntry.location).toEqual({
      city: "Mumbai",
      region: "Maharashtra",
      country: "India",
      latitude: 19.076,
      longitude: 72.8777,
    });

    const privateEntry = res.body.loginHistory.find((e: any) => e.ip === "127.0.0.1");
    expect(privateEntry).toBeDefined();
    expect(privateEntry.location).toBeNull();
  });

  it("uses the socket IP and ignores every client-supplied IP header and body field", () => {
    const { getRealClientIp } = require("../utils/ip");
    delete process.env.PROXY_SHARED_SECRET;
    const mockReq: any = {
      ip: "198.51.100.7",
      body: { clientIp: "1.2.3.4", ip: "5.6.7.8" },
      headers: {
        "x-client-ip": "9.9.9.9",
        "x-real-ip": "34.205.78.180",
        "x-forwarded-for": "103.42.193.24, 34.205.78.180",
        "cf-connecting-ip": "8.8.8.8",
      },
    };
    expect(getRealClientIp(mockReq)).toBe("198.51.100.7");
  });

  it("believes x-client-ip only together with the shared proxy secret", () => {
    const { getRealClientIp } = require("../utils/ip");
    process.env.PROXY_SHARED_SECRET = "s3cret-value";
    const base: any = { ip: "198.51.100.7", headers: { "x-client-ip": "103.42.193.24" } };
    expect(getRealClientIp({ ...base, headers: { ...base.headers, "x-proxy-secret": "s3cret-value" } })).toBe("103.42.193.24");
    expect(getRealClientIp({ ...base, headers: { ...base.headers, "x-proxy-secret": "wrong" } })).toBe("198.51.100.7");
    expect(getRealClientIp(base)).toBe("198.51.100.7");
    delete process.env.PROXY_SHARED_SECRET;
  });
});
