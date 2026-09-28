import { z } from "zod";

// Words that would collide with a route (`/api/workspaces/current`, the `personal` context signal,
// `/w/<slug>` pages) or that a user could mistake for the platform itself.
export const RESERVED_SLUGS = [
  "current", "personal", "new", "none", "null", "undefined", "api", "admin", "superadmin", "settings",
  "login", "logout", "signup", "invite", "invitations", "w", "workspaces", "www", "app", "beginso", "support",
];

const isTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const name = z.string().trim().min(1, "Workspace name is required").max(80, "Workspace name cannot exceed 80 characters");
const description = z.string().trim().max(500, "Description cannot exceed 500 characters").nullable();
const logo = z.string().trim().max(2048, "Logo URL is too long").nullable();
const timezone = z.string().trim().refine(isTimezone, "Invalid timezone: must be a valid IANA timezone string");
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, "Slug must be 3-50 characters: lowercase letters, numbers and hyphens, not starting or ending with a hyphen")
  .refine((s) => !RESERVED_SLUGS.includes(s), "That slug is reserved. Please choose another.");

// `mine` = only things assigned to me / created by me (the spec's `assigned`; kept as `mine`, the value the API has always used).
export const updatePreferencesSchema = z.object({
  notificationPreference: z.enum(["all", "mine", "none"]).optional(),
  timezoneOverride: timezone.nullable().optional(),
});

// Unknown keys (owner, _id, status...) are dropped, never stored.
export const createWorkspaceSchema = z.object({
  name,
  slug: slug.optional(),
  timezone: timezone.optional(),
  description: description.optional(),
  logo: logo.optional(),
});

export const updateWorkspaceSchema = z.object({
  name: name.optional(),
  timezone: timezone.optional(),
  description: description.optional(),
  logo: logo.optional(),
});
