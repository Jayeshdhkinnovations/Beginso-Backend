// How many forms show a mark, and the one-time switch of existing forms to "No icon". COUNTS ONLY: nothing here reads or prints a title, an owner, an answer or
// any other content of a form, and the migration only touches the three icon fields.
//
//   countFormIcons()           read-only: how many forms have a logo, an icon the form stores, a deliberate "No icon", or none of these
//   planFormIconMigration()    read-only: how many forms the migration would switch
//   applyFormIconMigration()   writes, and only when it is asked to
//
// A stored icon cannot be told apart from one the owner picked: the Create form page used to store the icon that suited the name without asking, so both look
// the same in the data. That is why switching existing forms is an owner's decision (and why the migration can be limited to a range of creation dates).
import Form from "../models/Form";

const hasText = (path: string) => ({ $and: [{ $ne: [{ $ifNull: [path, ""] }, ""] }, { $ne: [{ $type: path }, "missing"] }] });

export interface FormIconCounts {
  /** Forms that are not in Trash. */
  forms: number;
  /** In Trash: counted apart, and never switched. */
  trashed: number;
  withLogo: number;
  /** No logo, but a stored icon (picked by the owner, or stored for them when the form was created). */
  withIcon: number;
  /** The owner chose "No icon". */
  iconNone: number;
  /** No logo, no icon and no choice: an older form that never chose, shown with no mark. */
  neither: number;
  /** The forms with a stored icon (no logo), by the month they were created: where the guess started shows as a step in this list. */
  iconByMonth: Array<{ month: string; count: number }>;
}

const LIVE = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };

export async function countFormIcons(): Promise<FormIconCounts> {
  const [row] = await Form.aggregate([
    {
      $facet: {
        trashed: [{ $match: { deletedAt: { $ne: null } } }, { $count: "n" }],
        live: [
          { $match: LIVE },
          {
            $project: {
              logo: { $cond: [hasText("$branding.logoUrl"), 1, 0] },
              icon: { $cond: [hasText("$branding.iconName"), 1, 0] },
              none: { $cond: [{ $eq: ["$branding.iconNone", true] }, 1, 0] },
              createdAt: 1,
            },
          },
          {
            $group: {
              _id: null,
              forms: { $sum: 1 },
              withLogo: { $sum: "$logo" },
              withIcon: { $sum: { $cond: [{ $and: [{ $eq: ["$logo", 0] }, { $eq: ["$icon", 1] }] }, 1, 0] } },
              iconNone: { $sum: { $cond: [{ $and: [{ $eq: ["$logo", 0] }, { $eq: ["$icon", 0] }, { $eq: ["$none", 1] }] }, 1, 0] } },
              neither: { $sum: { $cond: [{ $and: [{ $eq: ["$logo", 0] }, { $eq: ["$icon", 0] }, { $eq: ["$none", 0] }] }, 1, 0] } },
            },
          },
        ],
        byMonth: [
          { $match: { ...LIVE, "branding.iconName": { $exists: true, $nin: [null, ""] }, $or: [{ "branding.logoUrl": { $exists: false } }, { "branding.logoUrl": { $in: [null, ""] } }] } },
          { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]);
  const live = row?.live?.[0] ?? { forms: 0, withLogo: 0, withIcon: 0, iconNone: 0, neither: 0 };
  return {
    forms: live.forms,
    trashed: row?.trashed?.[0]?.n ?? 0,
    withLogo: live.withLogo,
    withIcon: live.withIcon,
    iconNone: live.iconNone,
    neither: live.neither,
    iconByMonth: (row?.byMonth ?? []).map((m: { _id: string; count: number }) => ({ month: m._id, count: m.count })),
  };
}

export interface MigrationRange {
  /** Only forms created on or after this day (YYYY-MM-DD). */
  createdAfter?: string;
  /** Only forms created before this day (YYYY-MM-DD). */
  createdBefore?: string;
}

const parseDay = (value: string | undefined, name: string): Date | undefined => {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be a day like 2026-11-01`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`${name} is not a real day`);
  return d;
};

/** Forms that store an icon, have no logo, are not in Trash and did not already choose "No icon", within the dates asked for. */
function migrationFilter(range: MigrationRange) {
  const after = parseDay(range.createdAfter, "createdAfter");
  const before = parseDay(range.createdBefore, "createdBefore");
  return {
    ...LIVE,
    "branding.iconName": { $exists: true, $nin: [null, ""] },
    "branding.iconNone": { $ne: true },
    $and: [{ $or: [{ "branding.logoUrl": { $exists: false } }, { "branding.logoUrl": { $in: [null, ""] } }] }],
    ...(after || before ? { createdAt: { ...(after ? { $gte: after } : {}), ...(before ? { $lt: before } : {}) } } : {}),
  };
}

export async function planFormIconMigration(range: MigrationRange = {}): Promise<{ wouldSwitch: number }> {
  return { wouldSwitch: await Form.countDocuments(migrationFilter(range)) };
}

/** Switches the forms in range to "No icon": the stored icon and its colour are removed and iconNone is set. Nothing else on the form changes. */
export async function applyFormIconMigration(range: MigrationRange, options: { apply: boolean }): Promise<{ wouldSwitch: number; switched: number; applied: boolean }> {
  const { wouldSwitch } = await planFormIconMigration(range);
  if (!options.apply) return { wouldSwitch, switched: 0, applied: false };
  const res = await Form.updateMany(migrationFilter(range), { $set: { "branding.iconNone": true }, $unset: { "branding.iconName": "", "branding.iconColor": "" } });
  return { wouldSwitch, switched: res.modifiedCount, applied: true };
}
