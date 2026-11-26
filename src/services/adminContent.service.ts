import Form from "../models/Form";
import Workspace from "../models/Workspace";
import User from "../models/User";
import ResponseModel from "../models/Response";
import { escapeRegex } from "../utils/safeInput";
import { dayRange } from "../validations/adminContent.validator";

// Read-only list of the live forms of the whole platform, for the super admin console. STRICTLY metadata: a row is the form's id, title
// and status, its workspace and owner (id and name; the owner's email), a response count and two dates. Fields, settings, branding,
// slugs, answers and any response content are never selected or returned.
//
// Everything is one aggregation. Sorting by responses counts them in the database ($lookup with a count, no response is loaded). To keep
// the work small, a join runs before the sort only when a filter or the sort needs it; otherwise it runs for the page of rows alone.

export interface FormsListQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: "all" | "draft" | "published" | "closed";
  workspace?: string;
  owner?: string;
  createdFrom?: string;
  createdTo?: string;
  sort?: "title" | "workspace" | "owner" | "status" | "responses" | "created" | "updated";
  order?: "asc" | "desc";
}

const rx = (s: string) => ({ $regex: escapeRegex(s), $options: "i" });
const lower = (path: string) => ({ $toLower: { $ifNull: [path, ""] } });

const SORT_KEY: Record<NonNullable<FormsListQuery["sort"]>, unknown> = {
  title: lower("$title"),
  workspace: lower("$ws.name"),
  owner: lower("$owner.fullName"),
  status: "$status",
  responses: "$responseCount",
  created: "$createdAt",
  updated: "$updatedAt",
};

// The workspace's name and owner id, then the owner: the form's creator, else the workspace owner.
const joinWorkspace = [
  { $lookup: { from: Workspace.collection.name, localField: "workspaceId", foreignField: "_id", as: "ws", pipeline: [{ $project: { name: 1, owner: 1 } }] } },
  { $addFields: { ws: { $arrayElemAt: ["$ws", 0] } } },
];
const joinOwner = [
  { $addFields: { ownerId: { $ifNull: ["$createdBy", "$ws.owner"] } } },
  { $lookup: { from: User.collection.name, localField: "ownerId", foreignField: "_id", as: "owner", pipeline: [{ $project: { fullName: 1, email: 1 } }] } },
  { $addFields: { owner: { $arrayElemAt: ["$owner", 0] } } },
];
// Non-test, non-trashed responses only. The Response model's aggregate hook does not reach inside a $lookup, so isTest is excluded here too.
const joinResponses = [
  {
    $lookup: {
      from: ResponseModel.collection.name,
      localField: "_id",
      foreignField: "formId",
      as: "rc",
      pipeline: [{ $match: { deletedAt: null, isTest: { $ne: true } } }, { $count: "n" }],
    },
  },
  { $addFields: { responseCount: { $ifNull: [{ $arrayElemAt: ["$rc.n", 0] }, 0] } } },
];

export const listAdminForms = async (query: FormsListQuery) => {
  const page = Math.max(1, Math.floor(query.page || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit || 50)));
  const dir: 1 | -1 = (query.order ?? "desc") === "asc" ? 1 : -1;
  const sort = query.sort ?? "created";

  const match: Record<string, unknown> = { deletedAt: null };
  if (query.search) match.title = rx(query.search);
  if (query.status && query.status !== "all") match.status = query.status;
  const created = dayRange(query.createdFrom, query.createdTo);
  if (created) match.createdAt = created;

  const needOwner = !!query.owner || sort === "owner";
  const needWs = needOwner || !!query.workspace || sort === "workspace";
  const needResponses = sort === "responses";

  const early: any[] = [{ $match: match }];
  if (needWs) early.push(...joinWorkspace);
  if (query.workspace) early.push({ $match: { "ws.name": rx(query.workspace) } });
  if (needOwner) early.push(...joinOwner);
  if (query.owner) early.push({ $match: { $or: [{ "owner.fullName": rx(query.owner) }, { "owner.email": rx(query.owner) }] } });

  const countPipeline = [...early, { $count: "n" }];
  if (needResponses) early.push(...joinResponses);

  const late: any[] = [];
  if (!needWs) late.push(...joinWorkspace);
  if (!needOwner) late.push(...joinOwner);
  if (!needResponses) late.push(...joinResponses);

  const [rows, count] = await Promise.all([
    Form.aggregate([
      ...early,
      { $addFields: { sortKey: SORT_KEY[sort] } },
      { $sort: { sortKey: dir, _id: dir } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      ...late,
      {
        $project: {
          _id: 1,
          title: 1,
          status: 1,
          createdAt: 1,
          updatedAt: 1,
          responseCount: 1,
          "ws._id": 1,
          "ws.name": 1,
          "owner._id": 1,
          "owner.fullName": 1,
          "owner.email": 1,
        },
      },
    ]).allowDiskUse(true),
    Form.aggregate(countPipeline).allowDiskUse(true),
  ]);

  const total: number = count[0]?.n ?? 0;
  return {
    data: rows.map((f: any) => ({
      id: String(f._id),
      title: f.title,
      status: f.status,
      workspace: f.ws ? { id: String(f.ws._id), name: f.ws.name } : null,
      owner: f.owner ? { id: String(f.owner._id), name: f.owner.fullName, email: f.owner.email } : null,
      responseCount: f.responseCount ?? 0,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    })),
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  };
};
