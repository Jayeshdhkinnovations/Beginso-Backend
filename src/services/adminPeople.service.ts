import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Membership from "../models/Membership";
import { Event } from "../models/Event";
import { escapeRegex } from "../utils/safeInput";
import { DEFAULT_STORAGE_QUOTA_BYTES } from "./storage.service";
import { AdminsQuery, WorkspacesQuery, dayRange } from "../validations/adminPeople.validator";

// Read-only aggregations behind the super admin people lists. Filtering, sorting and paging happen in the
// database; per-row counts are computed only for the page's rows unless the count is the sort key.

const CI = { locale: "en", strength: 2 } as const; // case-insensitive ordering for text sort keys
const dir = (order?: "asc" | "desc"): 1 | -1 => (order === "asc" ? 1 : -1);
const contains = (s: string) => ({ $regex: escapeRegex(s), $options: "i" });
const paging = (q: { page?: number; limit?: number }, defaultLimit: number) => {
  const page = Math.max(1, q.page || 1);
  const limit = Math.min(100, Math.max(1, q.limit || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};
const pagination = (total: number, page: number, limit: number) => ({ total, page, limit, pages: Math.ceil(total / limit) });

// ---------------------------------------------------------------------------------------------------
// Admins
// ---------------------------------------------------------------------------------------------------

// Name of the admin's primary workspace (User.workspaceId). Empty when the user has none or it is gone.
const workspaceNameStages = (): any[] => [
  { $lookup: { from: Workspace.collection.name, localField: "workspaceId", foreignField: "_id", as: "_ws", pipeline: [{ $project: { name: 1 } }] } },
  { $addFields: { wsName: { $ifNull: [{ $arrayElemAt: ["$_ws.name", 0] }, null] } } },
  { $project: { _ws: 0 } },
];

// formCount: non-deleted forms of the primary workspace. responseCount: non-test responses (deleted
// responses included) of those forms. Same definitions the list always used.
const usageStages = (): any[] => [
  {
    $lookup: {
      from: Form.collection.name,
      let: { w: "$workspaceId" },
      as: "_forms",
      pipeline: [
        { $match: { $expr: { $eq: ["$workspaceId", "$$w"] }, deletedAt: null } },
        {
          $lookup: {
            from: ResponseModel.collection.name,
            let: { f: "$_id" },
            as: "_r",
            pipeline: [{ $match: { $expr: { $eq: ["$formId", "$$f"] }, isTest: { $ne: true } } }, { $count: "n" }],
          },
        },
        { $project: { r: { $ifNull: [{ $arrayElemAt: ["$_r.n", 0] }, 0] } } },
      ],
    },
  },
  { $addFields: { formCount: { $size: "$_forms" }, responseCount: { $sum: "$_forms.r" } } },
  { $project: { _forms: 0 } },
];

const ADMIN_SORT_FIELD: Record<string, string> = {
  name: "fullName",
  email: "email",
  workspace: "wsName",
  forms: "formCount",
  responses: "responseCount",
  storage: "_storage",
  registered: "createdAt",
  lastLogin: "lastLogin",
  status: "_status",
};

export const getAdminsList = async (q: AdminsQuery) => {
  const { page, limit, skip } = paging(q, 20);
  const sortKey = q.sort ?? "registered";

  const match: any = { role: "admin" };
  if (q.status) match.status = q.status;
  if (q.search) match.$or = [{ fullName: contains(q.search) }, { email: contains(q.search) }];
  const registered = dayRange(q.registeredFrom, q.registeredTo);
  if (registered) match.createdAt = registered;
  const active = dayRange(q.lastActiveFrom, q.lastActiveTo);
  if (active) match.lastLogin = active;

  const needWsName = !!q.workspace || sortKey === "workspace";
  const needUsage = sortKey === "forms" || sortKey === "responses";
  const base: any[] = [{ $match: match }];
  if (needWsName) base.push(...workspaceNameStages());
  if (q.workspace) base.push({ $match: { wsName: contains(q.workspace) } });

  const sortStages: any[] = [
    { $addFields: { _storage: { $ifNull: ["$storageUsedBytes", 0] }, _status: { $ifNull: ["$status", "active"] } } },
    { $sort: { [ADMIN_SORT_FIELD[sortKey]]: dir(q.order), _id: dir(q.order) } },
  ];

  const [rows, count] = await Promise.all([
    User.aggregate([
      ...base,
      ...(needUsage ? usageStages() : []),
      ...sortStages,
      { $skip: skip },
      { $limit: limit },
      ...(needWsName ? [] : workspaceNameStages()),
      ...(needUsage ? [] : usageStages()),
    ]).collation(CI),
    User.aggregate([...base, { $count: "n" }]),
  ]);

  const ids = rows.map((r: any) => r._id);
  const owned = await Workspace.aggregate([{ $match: { owner: { $in: ids } } }, { $group: { _id: "$owner", n: { $sum: 1 } } }]);
  const ownedBy = new Map(owned.map((w: any) => [String(w._id), w.n as number]));

  return {
    admins: rows.map((r: any) => ({
      id: String(r._id),
      name: r.fullName,
      email: r.email,
      workspaceName: r.wsName || "No Workspace",
      formCount: r.formCount ?? 0,
      responseCount: r.responseCount ?? 0,
      storageUsed: r.storageUsedBytes ?? 0,
      storageQuota: r.storageQuotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES,
      lastLogin: r.lastLogin ?? null,
      status: r.status || "active",
      createdAt: r.createdAt,
      workspaceCount: ownedBy.get(String(r._id)) ?? 0,
    })),
    pagination: pagination(count[0]?.n ?? 0, page, limit),
  };
};

// ---------------------------------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------------------------------

const countLookup = (from: string, as: string): any => ({
  $lookup: { from, let: { w: "$_id" }, as, pipeline: [{ $match: { $expr: { $eq: ["$workspaceId", "$$w"] } } }, { $count: "n" }] },
});

export const listWorkspacesPeople = async (q: WorkspacesQuery) => {
  const { page, limit, skip } = paging(q, 50);
  const sortKey = q.sort ?? "created";

  const match: any = {};
  if (q.search) match.name = contains(q.search);
  const created = dayRange(q.createdFrom, q.createdTo);
  if (created) match.createdAt = created;

  const needOwner = (!!q.owner && q.owner !== "any") || sortKey === "owner";
  const needMembers = q.minMembers !== undefined || q.maxMembers !== undefined || sortKey === "members";
  const needForms = q.minForms !== undefined || q.maxForms !== undefined || sortKey === "forms";

  const range = (field: string, min?: number, max?: number) => {
    const r: any = {};
    if (min !== undefined) r.$gte = min;
    if (max !== undefined) r.$lte = max;
    return Object.keys(r).length ? [{ $match: { [field]: r } }] : [];
  };

  const stages: any[] = [{ $match: match }];
  if (needOwner) {
    stages.push(
      { $lookup: { from: User.collection.name, localField: "owner", foreignField: "_id", as: "_o", pipeline: [{ $project: { fullName: 1 } }] } },
      { $addFields: { _ownerName: { $ifNull: [{ $arrayElemAt: ["$_o.fullName", 0] }, null] }, _hasOwner: { $gt: [{ $size: "$_o" }, 0] } } },
      { $project: { _o: 0 } }
    );
    if (q.owner === "has") stages.push({ $match: { _hasOwner: true } });
    if (q.owner === "none") stages.push({ $match: { _hasOwner: false } });
  }
  if (needMembers) {
    stages.push(countLookup(Membership.collection.name, "_m"), { $addFields: { _members: { $ifNull: [{ $arrayElemAt: ["$_m.n", 0] }, 0] } } }, { $project: { _m: 0 } });
    stages.push(...range("_members", q.minMembers, q.maxMembers));
  }
  if (needForms) {
    // Every form of the workspace, soft-deleted included, as the list always counted them.
    stages.push(countLookup(Form.collection.name, "_f"), { $addFields: { _forms: { $ifNull: [{ $arrayElemAt: ["$_f.n", 0] }, 0] } } }, { $project: { _f: 0 } });
    stages.push(...range("_forms", q.minForms, q.maxForms));
  }

  const sortField: Record<string, string> = { name: "name", owner: "_ownerName", members: "_members", forms: "_forms", created: "createdAt" };

  const [workspaces, count] = await Promise.all([
    Workspace.aggregate([...stages, { $sort: { [sortField[sortKey]]: dir(q.order), _id: dir(q.order) } }, { $skip: skip }, { $limit: limit }]).collation(CI),
    Workspace.aggregate([...stages, { $count: "n" }]),
  ]);

  const ids = workspaces.map((w: any) => w._id);
  const ownerIds = workspaces.map((w: any) => w.owner).filter(Boolean);
  const [members, forms, owners] = await Promise.all([
    Membership.aggregate([{ $match: { workspaceId: { $in: ids } } }, { $group: { _id: "$workspaceId", n: { $sum: 1 } } }]),
    Form.aggregate([{ $match: { workspaceId: { $in: ids } } }, { $group: { _id: "$workspaceId", n: { $sum: 1 } } }]),
    User.find({ _id: { $in: ownerIds } }, "fullName email").lean(),
  ]);
  const memberOf = new Map(members.map((m: any) => [String(m._id), m.n as number]));
  const formsOf = new Map(forms.map((m: any) => [String(m._id), m.n as number]));
  const ownerOf = new Map(owners.map((u: any) => [String(u._id), u]));

  return {
    data: workspaces.map((w: any) => {
      const o: any = w.owner ? ownerOf.get(String(w.owner)) : null;
      return {
        id: String(w._id),
        name: w.name,
        slug: w.slug,
        owner: o ? { id: String(o._id), name: o.fullName, email: o.email } : null,
        memberCount: memberOf.get(String(w._id)) ?? 0,
        formCount: formsOf.get(String(w._id)) ?? 0,
        createdAt: w.createdAt,
      };
    }),
    pagination: pagination(count[0]?.n ?? 0, page, limit),
  };
};

// ---------------------------------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------------------------------

// Labels can carry a person's name or email (a member, an invitee). Emails become a***@domain.com.
const EMAIL_RX = /([^\s@<>()",;]+)@([^\s@<>()",;]+\.[^\s@<>()",;]+)/g;
export const safeLabel = (label: unknown): string | null => {
  if (typeof label !== "string") return null;
  const masked = label.replace(EMAIL_RX, (_m, local: string, domain: string) => `${local.charAt(0)}***@${domain}`).trim().slice(0, 80).trim();
  return masked || null;
};

/** The user's 25 most recent recorded actions. Only id, action, target type, masked target label and time leave the database. */
export const getAdminActivity = async (id: string) => {
  const user = await User.exists({ _id: id, role: "admin" });
  if (!user) return null;
  const events = await Event.find({ actorId: id }, { action: 1, targetType: 1, targetLabel: 1, createdAt: 1 }).sort({ createdAt: -1, _id: -1 }).limit(25).lean();
  return events.map((e: any) => ({
    id: String(e._id),
    action: e.action,
    targetType: e.targetType,
    targetLabel: safeLabel(e.targetLabel),
    createdAt: e.createdAt,
  }));
};
