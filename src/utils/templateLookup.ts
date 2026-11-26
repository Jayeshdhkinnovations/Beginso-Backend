// Finding a template from the key in an address (its slug, its id, or an old slug). Its own file so it stays clear of the catalogue's data and tables.

/**
 * A template by its slug, then by its id, then by an OLD slug it replaces (a renamed template: general-contact-form -> contact-us). `redirectedFrom` is set
 * in the last case, so a caller can send the visitor on to the new address.
 */
export function findTemplateByKey<T extends { slug?: string; _id?: unknown; replaces?: string[] }>(all: T[], key: string): { found?: T; redirectedFrom?: string } {
  const direct = all.find((t) => t.slug === key) ?? all.find((t) => String(t._id) === key);
  if (direct) return { found: direct };
  const successor = all.find((t) => Array.isArray(t.replaces) && t.replaces.includes(key));
  return successor ? { found: successor, redirectedFrom: key } : {};
}
