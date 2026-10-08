import Dashboard from "../models/Dashboard";

const scopeFilter = (workspaceId: string | null, ownerId: string): any =>
  workspaceId ? { workspaceId, kind: "home" } : { workspaceId: null, ownerId, kind: "home" };

const out = (d: any) => ({ widgets: d.widgets, version: d.version });

export class DashboardLayoutService {
  async get(workspaceId: string | null, ownerId: string) {
    const d = await Dashboard.findOne(scopeFilter(workspaceId, ownerId)).lean();
    return d ? out(d) : null;
  }

  // Returns { conflict } (current stored layout) on version mismatch.
  async put(workspaceId: string | null, ownerId: string, widgets: unknown[], version?: number) {
    const filter = scopeFilter(workspaceId, ownerId);
    const existing = await Dashboard.findOne(filter).lean();
    if (!existing) {
      try {
        const created = await Dashboard.create({ ...filter, ownerId, widgets, version: 1 });
        return { dashboard: out(created) };
      } catch (e: any) {
        if (e?.code !== 11000) throw e;
        const raced = await Dashboard.findOne(filter).lean();
        return { conflict: raced ? out(raced) : null };
      }
    }
    if (version !== undefined && version !== existing.version) return { conflict: out(existing) };
    // Compare-and-set on version so concurrent writers cannot both win.
    const updated = await Dashboard.findOneAndUpdate(
      { ...filter, version: existing.version },
      { $set: { widgets, ownerId }, $inc: { version: 1 } },
      { new: true }
    ).lean();
    if (!updated) {
      const latest = await Dashboard.findOne(filter).lean();
      return { conflict: latest ? out(latest) : null };
    }
    return { dashboard: out(updated) };
  }

  async remove(workspaceId: string | null, ownerId: string) {
    await Dashboard.deleteOne(scopeFilter(workspaceId, ownerId));
  }
}
