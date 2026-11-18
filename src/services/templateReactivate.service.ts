// Switches built-in templates back ON. A wave sync switches off the older templates that a new one replaces (it never deletes them); this puts them
// back, so they show in the gallery again beside the new ones.
//
//   - Only built-in templates (workspaceId null) are looked at, and only ones that are switched off. A template a workspace published is never touched.
//   - A dry run by default: `planReactivation` only reads; `reactivateTemplates` writes only when it is asked to, and only the field isActive.
//   - Which templates: the slugs given, or (none given) every older template that a new one replaces.
import Template from "../models/Template";
import { REPLACES } from "../data/seedTemplates";

const BUILT_IN = { $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }] };

/** The older slugs that a new template replaces: what a wave sync switches off. */
export const replacedSlugs = (): string[] => [...new Set(Object.values(REPLACES).flat())].sort();

export interface ReactivationPlan {
  /** Switched off now, and would be switched on. */
  toSwitchOn: string[];
  /** Already on: nothing to do. */
  alreadyOn: string[];
  /** Not in the database as a built-in template. */
  missing: string[];
}
export interface ReactivationResult extends ReactivationPlan {
  applied: boolean;
  switchedOn: number;
}

export async function planReactivation(slugs: string[] = replacedSlugs()): Promise<ReactivationPlan> {
  const rows = await Template.find({ slug: { $in: slugs }, ...BUILT_IN }, { slug: 1, isActive: 1 }).lean();
  const bySlug = new Map(rows.map((r: any) => [r.slug, r]));
  const plan: ReactivationPlan = { toSwitchOn: [], alreadyOn: [], missing: [] };
  for (const slug of slugs) {
    const row: any = bySlug.get(slug);
    if (!row) plan.missing.push(slug);
    else if (row.isActive === false) plan.toSwitchOn.push(slug);
    else plan.alreadyOn.push(slug);
  }
  return plan;
}

export async function reactivateTemplates(slugs: string[] | undefined, options: { apply: boolean }): Promise<ReactivationResult> {
  const plan = await planReactivation(slugs);
  if (!options.apply || plan.toSwitchOn.length === 0) return { ...plan, applied: options.apply, switchedOn: 0 };
  const res = await Template.updateMany({ slug: { $in: plan.toSwitchOn }, ...BUILT_IN }, { $set: { isActive: true } });
  return { ...plan, applied: true, switchedOn: res.modifiedCount };
}
