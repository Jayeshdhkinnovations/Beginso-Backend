import { z } from "zod";
import mongoose from "mongoose";

// Query validation for the super admin people lists (admins, workspaces, storage) and the activity feed.
// An empty string means "not set" (a cleared filter box), so it never fails validation.

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

const text = opt(z.string().trim().max(200));
const intAtLeast1 = opt(z.coerce.number().int().min(1));
const intAtLeast0 = opt(z.coerce.number().int().min(0));
const order = opt(z.enum(["asc", "desc"]));

// "YYYY-MM-DD", a real calendar day, read as UTC.
const day = opt(
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .refine((s) => {
      const d = new Date(`${s}T00:00:00.000Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
    }, "Not a real date")
);

const paging = {
  page: intAtLeast1,
  // limit above 100 is clamped, as the list endpoints always did, not rejected.
  limit: opt(z.coerce.number().int().min(1).transform((n) => Math.min(n, 100))),
  search: text,
};

const ADMIN_SORTS = ["name", "email", "workspace", "forms", "responses", "storage", "registered", "lastLogin", "status"] as const;
const WORKSPACE_SORTS = ["name", "owner", "members", "forms", "created"] as const;
const STORAGE_SORTS = ["used", "quota", "name", "workspaces", "state"] as const;

export const adminsQuerySchema = z.object({
  ...paging,
  status: opt(z.enum(["active", "suspended"])),
  workspace: text,
  registeredFrom: day,
  registeredTo: day,
  lastActiveFrom: day,
  lastActiveTo: day,
  sort: opt(z.enum(ADMIN_SORTS)),
  order,
});

export const workspacesQuerySchema = z.object({
  ...paging,
  owner: opt(z.enum(["any", "has", "none"])),
  minMembers: intAtLeast0,
  maxMembers: intAtLeast0,
  minForms: intAtLeast0,
  maxForms: intAtLeast0,
  createdFrom: day,
  createdTo: day,
  sort: opt(z.enum(WORKSPACE_SORTS)),
  order,
});

export const storageQuerySchema = z.object({
  ...paging,
  state: opt(z.enum(["under", "over_quota", "over_ceiling"])),
  sort: opt(z.enum(STORAGE_SORTS)),
  order,
});

export type AdminsQuery = z.infer<typeof adminsQuerySchema>;
export type WorkspacesQuery = z.infer<typeof workspacesQuerySchema>;
export type StorageQuery = z.infer<typeof storageQuerySchema>;

const unprocessable = (message: string): Error => Object.assign(new Error(message), { statusCode: 422 });

/** Parses a query string object; throws an error carrying statusCode 422 and a readable message when invalid. */
export const parseQuery = <S extends z.ZodType>(schema: S, query: unknown): z.infer<S> => {
  const result = schema.safeParse(query);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join(".");
    throw unprocessable(field ? `Invalid ${field}: ${issue.message}` : issue.message);
  }
  return result.data;
};

export const parseObjectId = (id: unknown): string => {
  if (typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id) || !/^[a-f0-9]{24}$/i.test(id)) {
    throw unprocessable("Invalid id");
  }
  return id;
};

/** Start of the day (UTC) and the start of the next day, for an inclusive "YYYY-MM-DD" range. */
export const dayRange = (from?: string, to?: string): Record<string, Date> | undefined => {
  const range: Record<string, Date> = {};
  if (from) range.$gte = new Date(`${from}T00:00:00.000Z`);
  if (to) range.$lt = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);
  return Object.keys(range).length ? range : undefined;
};
