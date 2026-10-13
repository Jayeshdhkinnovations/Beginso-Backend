// Forms listing: the whole set is reachable by paging past 500 forms, and `sort` orders it on the server, stably across pages.
process.env.JWT_SECRET = "test-jwt-secret-key-for-forms-listing";
process.env.RATE_LIMIT_MAX = "0";
process.env.AUTH_RATE_LIMIT_MAX = "0";

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import app from "../app";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Membership from "../models/Membership";
import Form from "../models/Form";
import { generateToken } from "../utils/generateToken";

let mongo: MongoMemoryServer;
let owner: any, ws: any;
const TOTAL = 520;
const headers = () => ({ Authorization: `Bearer ${generateToken({ id: owner._id.toString(), email: owner.email, role: "user" })}`, "x-workspace-id": ws._id.toString() });

const pageThrough = async (query: string) => {
  const titles: string[] = [];
  const ids: string[] = [];
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const res = await request(app).get(`/api/forms?limit=50&page=${page}&${query}`).set(headers());
    expect(res.status).toBe(200);
    pages = res.body.pages;
    for (const f of res.body.forms) { titles.push(f.title); ids.push(f._id); }
  }
  return { titles, ids };
};

beforeAll(async () => {
  await mongoose.disconnect();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  owner = await User.create({ firebaseUid: "uid-fl-owner", fullName: "Owner", email: "owner@fl.test", status: "active" });
  ws = await Workspace.create({ name: "Listing WS", owner: owner._id });
  await Membership.create({ userId: owner._id, workspaceId: ws._id, role: "owner" });
  const page = [{ id: "p1", order: 0, title: "Page" }];
  const fields = [{ fieldId: "f1", pageId: "p1", label: "Name", type: "short_text", required: false }];
  const base = Date.now() - 1_000_000;
  // Many forms share a title (every 4th) and a createdAt second, so only a tie-break keeps pages stable.
  await Form.insertMany(
    Array.from({ length: TOTAL }, (_, i) => ({
      title: i % 4 === 0 ? "Same title" : `${i % 2 ? "b" : "B"}form ${String(i).padStart(4, "0")}`,
      workspaceId: ws._id, createdBy: owner._id, status: i % 3 ? "published" : "draft", fields, pages: page,
      createdAt: new Date(base + Math.floor(i / 5) * 1000),
    })) as any,
  );
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("GET /api/forms", () => {
  it("returns every form when paged to the end, with no duplicates", async () => {
    const first = await request(app).get("/api/forms?limit=50&page=1").set(headers());
    expect(first.body.total).toBe(TOTAL);
    expect(first.body.pages).toBe(11);
    const { ids } = await pageThrough("");
    expect(ids).toHaveLength(TOTAL);
    expect(new Set(ids).size).toBe(TOTAL);
  });

  it("sorts by title on the server across pages, case-insensitively, without repeats or gaps", async () => {
    const asc = await pageThrough("sort=title&order=asc");
    expect(asc.ids).toHaveLength(TOTAL);
    expect(new Set(asc.ids).size).toBe(TOTAL);
    const lower = asc.titles.map((t) => t.toLowerCase());
    expect(lower).toEqual([...lower].sort((a, b) => a.localeCompare(b, "en")));
    const desc = await pageThrough("sort=title&order=desc");
    expect(desc.titles.map((t) => t.toLowerCase())).toEqual([...lower].reverse());
  });

  it("sorts by createdAt and updatedAt in both directions, stably", async () => {
    for (const field of ["createdAt", "updatedAt"]) {
      for (const order of ["asc", "desc"]) {
        const { ids } = await pageThrough(`sort=${field}&order=${order}`);
        expect(new Set(ids).size).toBe(TOTAL);
      }
    }
    const newest = await request(app).get("/api/forms?limit=1&sort=createdAt&order=desc").set(headers());
    const oldest = await request(app).get("/api/forms?limit=1&sort=createdAt&order=asc").set(headers());
    expect(new Date(newest.body.forms[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(oldest.body.forms[0].createdAt).getTime());
  });

  it("ignores an unknown sort field and keeps the default order", async () => {
    const def = await request(app).get("/api/forms?limit=5").set(headers());
    const bogus = await request(app).get("/api/forms?limit=5&sort=password&order=asc").set(headers());
    expect(bogus.status).toBe(200);
    expect(bogus.body.forms.map((f: any) => f._id)).toEqual(def.body.forms.map((f: any) => f._id));
  });
});
