// Keeps the built-in templates in the database in step with the catalogue in data/builtInTemplates.ts WITHOUT deleting anything.
//
//   - Matched by `slug`, so a template keeps its _id (a link, a sign-up in progress or "use this template" never points at a template that was recreated).
//   - A template that is in the catalogue and not in the database is added; one that differs is updated; one that is the same is left alone.
//   - A built-in template that is no longer in the catalogue is set `isActive: false` (hidden from every list), never deleted.
//   - Only built-in templates are looked at (workspaceId null). A template a workspace published is never read, changed or deactivated.
//   - `planTemplateSync` is pure and only reads; `applyTemplateSync` writes, and only when it is asked to.
import Template from "../models/Template";

/** What is compared: the content of a template, not its id, its timestamps or who owns it. */
const COMPARED = ["name", "description", "category", "tags", "featured", "sortOrder", "estimatedMinutes", "thumbnail", "fields", "pages", "theme", "settings", "branding", "showInGallery", "isActive"] as const;

export interface SyncChange {
  slug: string;
  /** Which of the compared parts differ. */
  fields: string[];
}
export interface SyncPlan {
  added: string[];
  changed: SyncChange[];
  deactivated: string[];
  unchanged: number;
  /** A catalogue slug that a template which is NOT built-in already uses: skipped, never overwritten. */
  conflicts: string[];
}
export interface SyncResult extends SyncPlan {
  applied: boolean;
}

/** The same value without ids, timestamps and undefined, in a fixed key order, so two equal templates compare equal as text. */
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    if (typeof value.toHexString === "function") return String(value);
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      // _id and a show-if rule's ruleId are made up each time a template is built: they are not part of what the template says
      if (key === "_id" || key === "ruleId" || value[key] === undefined) continue;
      out[key] = stable(value[key]);
    }
    return out;
  }
  return value;
}

/** A catalogue entry as the database would hold it (the model fills its own defaults), so it can be compared with a stored row. */
function asStored(entry: Record<string, any>): Record<string, any> {
  const doc = new Template({ ...entry, isActive: entry.isActive !== false, workspaceId: null }).toObject();
  const picked: Record<string, any> = {};
  for (const key of COMPARED) picked[key] = (doc as any)[key];
  return stable(picked);
}

const BUILT_IN = { $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }] };

export async function planTemplateSync(catalogue: Array<Record<string, any>>): Promise<SyncPlan> {
  const existing = await Template.find({ slug: { $in: catalogue.map((c) => c.slug) } });
  const builtInRows = await Template.find(BUILT_IN);
  const bySlug = new Map(existing.map((t) => [t.slug, t]));
  const plan: SyncPlan = { added: [], changed: [], deactivated: [], unchanged: 0, conflicts: [] };
  const wanted = new Set(catalogue.map((c) => String(c.slug)));

  for (const entry of catalogue) {
    const row = bySlug.get(entry.slug);
    if (!row) {
      plan.added.push(entry.slug);
      continue;
    }
    if (row.workspaceId) {
      plan.conflicts.push(entry.slug);
      continue;
    }
    const want = asStored(entry);
    const have = stable(Object.fromEntries(COMPARED.map((k) => [k, (row.toObject() as any)[k]])));
    const differing = COMPARED.filter((k) => JSON.stringify(want[k]) !== JSON.stringify(have[k]));
    if (differing.length) plan.changed.push({ slug: entry.slug, fields: [...differing] });
    else plan.unchanged += 1;
  }
  for (const row of builtInRows) {
    if (row.slug && !wanted.has(row.slug) && row.isActive !== false) plan.deactivated.push(row.slug);
  }
  return plan;
}

/** Plans the sync and, only with `apply`, performs it. Without `apply` nothing is written. */
export async function syncTemplates(catalogue: Array<Record<string, any>>, options: { apply: boolean }): Promise<SyncResult> {
  const plan = await planTemplateSync(catalogue);
  if (!options.apply) return { ...plan, applied: false };

  const bySlug = new Map(catalogue.map((c) => [String(c.slug), c]));
  for (const slug of plan.added) {
    await Template.create({ ...bySlug.get(slug), isActive: bySlug.get(slug)!.isActive !== false, workspaceId: null });
  }
  for (const change of plan.changed) {
    const entry = bySlug.get(change.slug)!;
    const set: Record<string, any> = {};
    for (const key of change.fields) set[key] = (entry as any)[key] ?? (key === "isActive" ? true : undefined);
    set.isActive = entry.isActive !== false;
    await Template.updateOne({ slug: change.slug, ...BUILT_IN }, { $set: set });
  }
  if (plan.deactivated.length) {
    await Template.updateMany({ slug: { $in: plan.deactivated }, ...BUILT_IN }, { $set: { isActive: false } });
  }
  return { ...plan, applied: true };
}
