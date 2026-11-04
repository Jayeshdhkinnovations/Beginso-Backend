// Photo search for a form's page background or cover, from Unsplash. The Access Key stays here (UNSPLASH_ACCESS_KEY): the browser only ever talks to our own
// /api/unsplash. Unsplash's free plan allows 50 requests an hour, so results are cached for a while and a busy answer is turned into a plain message.
//
// What Unsplash asks of an app (https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines): hotlink the photo (we store the images.unsplash.com address,
// never a copy), tell them when a photo is used (trackDownload), and credit the photographer and Unsplash with a link (the credit travels with the form).

const API = "https://api.unsplash.com";
const UTM = "utm_source=beginso&utm_medium=referral";
const TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 300;
const TIMEOUT_MS = 8000;
const PER_PAGE = 24;

export class UnsplashError extends Error {
  constructor(public status: number, public code: "NOT_CONFIGURED" | "BUSY" | "UNAVAILABLE", message: string) {
    super(message);
  }
}

export interface UnsplashPhoto {
  id: string;
  /** A small preview (about 400px wide). */
  thumb: string;
  /** The picture to put on a form: the original sized and compressed for a full-width page. */
  url: string;
  alt: string;
  credit: { name: string; url: string };
}

export interface UnsplashPage {
  photos: UnsplashPhoto[];
  page: number;
  totalPages: number;
}

const cache = new Map<string, { at: number; value: UnsplashPage }>();
/** Tests (and a deploy that changes the key) start from an empty cache. */
export const clearUnsplashCache = (): void => cache.clear();

const accessKey = (): string => {
  const key = (process.env.UNSPLASH_ACCESS_KEY ?? "").trim();
  if (!key) throw new UnsplashError(503, "NOT_CONFIGURED", "Photo search is not switched on for this server yet.");
  return key;
};

async function call(path: string): Promise<Response> {
  const key = accessKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${API}${path}`, { headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" }, signal: controller.signal });
  } catch {
    throw new UnsplashError(503, "UNAVAILABLE", "Photo search is not answering right now. Try again in a moment.");
  } finally {
    clearTimeout(timer);
  }
}

const safeHttps = (value: unknown, host: string): string | null => {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === host && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
};

/** One result as the app uses it. Anything that is not exactly what we expect (an address on another host, a missing name) drops the photo. */
export function toPhoto(raw: any): UnsplashPhoto | null {
  const id = typeof raw?.id === "string" && /^[A-Za-z0-9_-]{6,24}$/.test(raw.id) ? raw.id : null;
  const rawUrl = safeHttps(raw?.urls?.raw, "images.unsplash.com");
  const thumb = safeHttps(raw?.urls?.small, "images.unsplash.com");
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  const name = typeof raw?.user?.name === "string" ? raw.user.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : "";
  const profile = safeHttps(raw?.user?.links?.html, "unsplash.com");
  if (!id || !rawUrl || !thumb || !name || !profile) return null;
  const url = new URL(rawUrl);
  url.searchParams.set("w", "1920");
  url.searchParams.set("q", "75");
  url.searchParams.set("fit", "max");
  url.searchParams.set("auto", "format");
  const credit = new URL(profile);
  credit.search = UTM;
  return { id, thumb, url: url.href, alt: typeof raw?.alt_description === "string" ? raw.alt_description.slice(0, 160) : "", credit: { name, url: credit.href } };
}

/** Landscape photos for a search (or, with no search, the editorial feed), a page at a time. */
export async function searchPhotos(query: string, page: number): Promise<UnsplashPage> {
  const q = query.trim().slice(0, 80);
  const key = `${q.toLowerCase()}|${page}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const path = q
    ? `/search/photos?query=${encodeURIComponent(q)}&page=${page}&per_page=${PER_PAGE}&orientation=landscape&content_filter=high`
    : `/photos?page=${page}&per_page=${PER_PAGE}&order_by=popular`;
  const res = await call(path);
  // Unsplash answers 403 (and 429) when the hourly allowance is used up
  if (res.status === 403 || res.status === 429) throw new UnsplashError(429, "BUSY", "Photo search is busy. Try again in a few minutes.");
  if (res.status === 401) throw new UnsplashError(503, "NOT_CONFIGURED", "Photo search is not switched on for this server yet.");
  if (!res.ok) throw new UnsplashError(503, "UNAVAILABLE", "Photo search is not answering right now. Try again in a moment.");
  const body: any = await res.json().catch(() => null);
  const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : [];
  const value: UnsplashPage = {
    photos: list.map(toPhoto).filter((p): p is UnsplashPhoto => p !== null),
    page,
    totalPages: Math.max(1, Math.min(Number(body?.total_pages) || 1, 50)),
  };
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Photos picked by hand for forms (soft gradients, a paper texture, a bright desk, a lake, the sea, leaves). They are looked up once a day and kept, so showing
 * them as the first row of the picker costs almost none of Unsplash's hourly allowance. They are linked from Unsplash like any other photo, never copied.
 */
export const FEATURED_IDS = ["pJadQetzTkI", "oPH_5xuMgQw", "yQAs-jLjwUg", "hPCFOFtmNls", "GA09PKfRIQY", "6ArTTluciuA", "tETOGm8n45A"] as const;
const FEATURED_TTL_MS = 24 * 60 * 60 * 1000;
let featured: { at: number; photos: UnsplashPhoto[] } | null = null;

export async function featuredPhotos(): Promise<UnsplashPhoto[]> {
  if (featured && Date.now() - featured.at < FEATURED_TTL_MS) return featured.photos;
  accessKey(); // say "not switched on" before making seven calls that cannot work
  const results = await Promise.allSettled(
    FEATURED_IDS.map(async (id) => {
      const res = await call(`/photos/${id}`);
      if (res.status === 403 || res.status === 429) throw new UnsplashError(429, "BUSY", "Photo search is busy. Try again in a few minutes.");
      if (!res.ok) throw new UnsplashError(503, "UNAVAILABLE", "Photo search is not answering right now. Try again in a moment.");
      return toPhoto(await res.json().catch(() => null));
    }),
  );
  const photos = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
  if (photos.length === 0) {
    const busy = results.find((r) => r.status === "rejected" && (r.reason as UnsplashError)?.code === "BUSY");
    throw busy ? (busy as PromiseRejectedResult).reason : new UnsplashError(503, "UNAVAILABLE", "Photo search is not answering right now. Try again in a moment.");
  }
  // a partly answered list is kept for a short while only, so the missing photos are asked for again soon
  featured = { at: photos.length === FEATURED_IDS.length ? Date.now() : Date.now() - FEATURED_TTL_MS + 5 * 60 * 1000, photos };
  return photos;
}

/** Tests start from nothing kept. */
export const clearFeatured = (): void => {
  featured = null;
};

/** Tells Unsplash a photo was used on a form (their rule, and how photographers are counted). Best effort: a failure here never blocks the person. */
export async function trackDownload(id: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{6,24}$/.test(id)) return;
  try {
    await call(`/photos/${id}/download`);
  } catch {
    /* nothing to tell the person */
  }
}
