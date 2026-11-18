// The built-in template catalogue's structure: the twelve groups a visitor browses by, the tags a template can carry besides its group, the order
// and the featured six, the time it takes to fill, and the notes and pictures that are added to the plain data in data/builtInTemplates.ts.
// Pure functions, no database: used by the seed script, the safe sync and the tests.

export const CATEGORY_GROUPS = [
  "Leads & Contact",
  "Orders & Payments",
  "Events & RSVPs",
  "Bookings",
  "Feedback & Surveys",
  "HR & Hiring",
  "Education",
  "Healthcare",
  "Real Estate",
  "Community & Membership",
  "Internal Requests & Inspections",
  "Consent & Legal",
  "Fun & Polls",
] as const;
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

/** Every category name the catalogue used before the regrouping, and the group it belongs to now, so an old link or a saved choice still resolves. */
export const LEGACY_CATEGORY_MAP: Record<string, CategoryGroup> = {
  "Lead Generation": "Leads & Contact",
  "Contact us": "Leads & Contact",
  Business: "Leads & Contact",
  General: "Leads & Contact",
  "E-commerce": "Orders & Payments",
  Order: "Orders & Payments",
  Events: "Events & RSVPs",
  Personal: "Events & RSVPs",
  "Reservation/Booking": "Bookings",
  Feedback: "Feedback & Surveys",
  HR: "HR & Hiring",
  Education: "Education",
  Medicine: "Healthcare",
  "Real Estate": "Real Estate",
  "Non-profit": "Community & Membership",
  Membership: "Community & Membership",
  Registration: "Community & Membership",
  "Working Forms": "Internal Requests & Inspections",
  Requests: "Internal Requests & Inspections",
  "Inspection Forms": "Internal Requests & Inspections",
  advanced: "Internal Requests & Inspections",
  Consent: "Consent & Legal",
};

/** A group name, or an old category name, as the group it is now (case-insensitive); undefined when it is neither. */
export function resolveCategoryGroup(name: unknown): CategoryGroup | undefined {
  if (typeof name !== "string") return undefined;
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  const current = CATEGORY_GROUPS.find((g) => g.toLowerCase() === wanted);
  if (current) return current;
  const old = Object.keys(LEGACY_CATEGORY_MAP).find((k) => k.toLowerCase() === wanted);
  return old ? LEGACY_CATEGORY_MAP[old] : undefined;
}

export interface CatalogMeta {
  category: CategoryGroup;
  /** Other groups it also belongs to, and what it is for. A template may carry several. */
  tags: string[];
  featured?: boolean;
}

// Listed in the order they are shown: the position in this object (within the whole catalogue) is the sort order.
export const CATALOG_META: Record<string, CatalogMeta> = {
  // Leads & Contact
  "free-trial-request": { category: "Leads & Contact", tags: ["Sales", "SaaS"], featured: true },
  "contact-sales": { category: "Leads & Contact", tags: ["Sales"] },
  "general-contact-form": { category: "Leads & Contact", tags: ["Website"] },
  "support-request": { category: "Leads & Contact", tags: ["Support"] },
  "newsletter-signup": { category: "Leads & Contact", tags: ["Marketing"] },
  "product-waitlist": { category: "Leads & Contact", tags: ["Marketing", "Orders & Payments"] },
  "waitlist": { category: "Leads & Contact", tags: ["SaaS", "Marketing"] },
  "partnership-inquiry": { category: "Leads & Contact", tags: ["Business"] },
  // Orders & Payments
  "product-order-form": { category: "Orders & Payments", tags: ["Shop"] },
  "return-exchange-request": { category: "Orders & Payments", tags: ["Shop", "Support"] },
  "food-delivery-order": { category: "Orders & Payments", tags: ["Food"] },
  "service-order-request": { category: "Orders & Payments", tags: ["Services"] },
  "donation-form": { category: "Orders & Payments", tags: ["Community & Membership", "Donations"] },
  // Events & RSVPs
  "event-registration": { category: "Events & RSVPs", tags: ["Registration"], featured: true },
  "webinar-signup": { category: "Events & RSVPs", tags: ["Registration", "Online"] },
  "wedding-rsvp": { category: "Events & RSVPs", tags: ["RSVP", "Personal"] },
  "party-rsvp": { category: "Events & RSVPs", tags: ["RSVP", "Personal"] },
  "fundraising-event-registration": { category: "Events & RSVPs", tags: ["Community & Membership", "Registration"] },
  // Bookings
  "appointment-booking": { category: "Bookings", tags: ["Appointments"], featured: true },
  "table-reservation": { category: "Bookings", tags: ["Food"] },
  "venue-room-booking": { category: "Bookings", tags: ["Venues"] },
  "schedule-a-viewing": { category: "Bookings", tags: ["Real Estate", "Appointments"] },
  // Feedback & Surveys
  "customer-satisfaction-survey": { category: "Feedback & Surveys", tags: ["Customers"], featured: true },
  "net-promoter-score": { category: "Feedback & Surveys", tags: ["Customers"] },
  "website-feedback": { category: "Feedback & Surveys", tags: ["Website"] },
  "student-feedback-survey": { category: "Feedback & Surveys", tags: ["Education"] },
  // HR & Hiring
  "job-application": { category: "HR & Hiring", tags: ["Hiring"], featured: true },
  "employee-onboarding": { category: "HR & Hiring", tags: ["Onboarding"] },
  "exit-interview": { category: "HR & Hiring", tags: ["Feedback & Surveys"] },
  // Education
  "course-enrollment": { category: "Education", tags: ["Registration"] },
  "scholarship-application": { category: "Education", tags: ["Applications"] },
  // Healthcare
  "patient-intake-form": { category: "Healthcare", tags: ["Intake"] },
  "appointment-request": { category: "Healthcare", tags: ["Bookings", "Appointments"] },
  "telehealth-consultation": { category: "Healthcare", tags: ["Online", "Intake"] },
  // Real Estate
  "property-inquiry": { category: "Real Estate", tags: ["Leads & Contact"] },
  "rental-application": { category: "Real Estate", tags: ["Applications"] },
  "roommate-application": { category: "Real Estate", tags: ["Applications", "Personal"] },
  // Community & Membership
  "volunteer-signup": { category: "Community & Membership", tags: ["Non-profit"], featured: true },
  "member-registration": { category: "Community & Membership", tags: ["Registration"] },
  "gym-membership-application": { category: "Community & Membership", tags: ["Fitness", "Applications"] },
  "club-membership-renewal": { category: "Community & Membership", tags: ["Renewals"] },
  // Internal Requests & Inspections
  "it-support-request": { category: "Internal Requests & Inspections", tags: ["Support", "IT"] },
  "equipment-request": { category: "Internal Requests & Inspections", tags: ["Requests"] },
  "timesheet-submission": { category: "Internal Requests & Inspections", tags: ["HR & Hiring"] },
  "expense-reimbursement-request": { category: "Internal Requests & Inspections", tags: ["Finance"] },
  "vendor-onboarding": { category: "Internal Requests & Inspections", tags: ["Vendors"] },
  "vendor-registration": { category: "Internal Requests & Inspections", tags: ["Vendors", "Events & RSVPs"] },
  "vehicle-inspection-checklist": { category: "Internal Requests & Inspections", tags: ["Inspections"] },
  "property-inspection-report": { category: "Internal Requests & Inspections", tags: ["Inspections", "Real Estate"] },
  "pitch-plan": { category: "Internal Requests & Inspections", tags: ["Planning"] },
  // Consent & Legal
  "photo-video-consent-form": { category: "Consent & Legal", tags: ["Consent"] },
  "medical-treatment-consent": { category: "Consent & Legal", tags: ["Consent", "Healthcare"] },
};

const ORDER = Object.keys(CATALOG_META);

/** The position of a template in the gallery (lower is first); a template that is not in the catalogue goes after all of them. */
export const catalogSortOrder = (slug: string): number => {
  const i = ORDER.indexOf(slug);
  return i < 0 ? ORDER.length + 1 : i + 1;
};

// How long a form takes to fill in, from what it asks for: a short answer takes seconds, a paragraph or a file takes a minute.
const SECONDS: Record<string, number> = {
  long_text: 60,
  file_upload: 60,
  image_upload: 60,
  address: 45,
  signature: 30,
  datetime: 20,
  date: 15,
  time: 15,
  yes_no: 8,
  rating: 8,
  dropdown: 10,
  multiple_choice: 10,
  checkbox: 15,
  number: 10,
};
/** Whole minutes, at least 1, for the fields that are not deleted. */
export function estimateMinutes(fields: Array<{ type?: string; deleted?: boolean }> | undefined): number {
  const seconds = (fields ?? []).filter((f) => !f.deleted).reduce((sum, f) => sum + (SECONDS[f.type ?? ""] ?? 20), 0);
  return Math.max(1, Math.ceil(seconds / 60));
}

/** Templates that ask for health, tax or other sensitive details: they carry a plain note and never claim a compliance. */
export const SENSITIVE_SLUGS = [
  "patient-intake-form",
  "telehealth-consultation",
  "medical-treatment-consent",
  "gym-membership-application",
  "vendor-onboarding",
  "expense-reimbursement-request",
] as const;
export const SAMPLE_NOTE = "Sample template. Check the wording and data rules for your country with a professional before using it.";

// Our own pictures (the frontend's public/form-pictures), chosen by group. Used instead of photos whose photographer we do not know.
const PICTURES: Record<CategoryGroup, string[]> = {
  "Leads & Contact": ["electric-blue", "deep-sea"],
  "Orders & Payments": ["citrus-light", "sunset-orange"],
  "Events & RSVPs": ["confetti", "magenta-sky", "violet-pink"],
  Bookings: ["ocean-mist", "calm-waves"],
  "Feedback & Surveys": ["lavender-haze", "aurora-mint"],
  "HR & Hiring": ["carbon", "mono-waves"],
  Education: ["forest-glow", "teal-lime"],
  Healthcare: ["ocean-mist", "aurora-mint"],
  "Real Estate": ["sand-dunes", "topo-lines"],
  "Community & Membership": ["coral-waves", "sunrise-peach"],
  "Internal Requests & Inspections": ["grid-paper", "dots-ink"],
  "Consent & Legal": ["mono-waves", "plum-night"],
  "Fun & Polls": ["confetti", "citrus-light"],
};
const hash = (text: string): number => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const libraryPicture = (group: CategoryGroup, slug: string): string => {
  const list = PICTURES[group];
  return `/form-pictures/${list[hash(slug) % list.length]}.jpg`;
};

const UNSPLASH = /^https:\/\/images\.unsplash\.com\//;
const hasPhotoCredit = (branding: any): boolean => !!branding?.theme?.credit;

/**
 * One plain template entry, completed: its group, tags, featured flag, sort order and time to fill; the sample note on the sensitive ones; and no photo
 * whose photographer is not credited (it is swapped for one of our own pictures, because the credit cannot be guessed).
 */
export function applyCatalogMeta<T extends Record<string, any>>(template: T): T & { category: string; tags: string[]; featured: boolean; sortOrder: number; estimatedMinutes: number } {
  const slug = String(template.slug ?? "");
  const meta = CATALOG_META[slug];
  // One of the 77 (it carries its wave) brings its own group, tags, featured flag and order; an older template takes them from the table below.
  const own = typeof template.wave === "number";
  const category: CategoryGroup = (own ? resolveCategoryGroup(template.category) : undefined) ?? meta?.category ?? resolveCategoryGroup(template.category) ?? "Leads & Contact";
  let branding = template.branding;
  if (branding && !hasPhotoCredit(branding)) {
    const swapped = { ...branding };
    for (const key of ["coverImageUrl", "backgroundImageUrl"]) {
      if (typeof swapped[key] === "string" && UNSPLASH.test(swapped[key])) swapped[key] = libraryPicture(category, `${slug}:${key}`);
    }
    branding = swapped;
  }
  const sensitive = (SENSITIVE_SLUGS as readonly string[]).includes(slug);
  const description = typeof template.description === "string" ? template.description : "";
  return {
    ...template,
    category,
    tags: own && Array.isArray(template.tags) ? template.tags : (meta?.tags ?? []),
    featured: own ? template.featured === true : meta?.featured === true,
    // the 77 come first in the gallery (their own order, 1 to 77); the older ones follow
    sortOrder: own && typeof template.sortOrder === "number" ? template.sortOrder : 100 + catalogSortOrder(slug),
    estimatedMinutes: typeof template.estimatedMinutes === "number" ? template.estimatedMinutes : estimateMinutes(template.fields),
    ...(branding ? { branding } : {}),
    ...(sensitive && description && !description.includes(SAMPLE_NOTE) && !/Sample template./.test(description) ? { description: `${description} ${SAMPLE_NOTE}` } : {}),
  };
}

/** The group a stored category belongs to: a current group as it is, an old category name through the old-name map (so a catalogue that has not been
 * synced yet still lands in the right group), and anything else as written. */
export const groupOfCategory = (category: unknown): string => resolveCategoryGroup(category) ?? (typeof category === "string" ? category : "");

/** The groups of the gallery with their counts: the current groups in their order, then any other name that is in use. A group with no template is left out. */
export function galleryGroups(categories: unknown[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of categories) {
    const name = groupOfCategory(c);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const ordered: string[] = [...CATEGORY_GROUPS, ...[...counts.keys()].filter((n) => !(CATEGORY_GROUPS as readonly string[]).includes(n))];
  return ordered.filter((n) => (counts.get(n) ?? 0) > 0).map((name) => ({ name, count: counts.get(name) as number }));
}
