import dns from "dns";
import http from "http";
import https from "https";
import net from "net";

// Link preview for a URL a respondent typed into a form. The URL is untrusted and the fetch runs from our
// network, so it is built to be unable to reach anything private (SSRF): http(s) on the default ports only,
// no IP literals in private ranges, every resolved address re-checked at connect time (defeats DNS
// rebinding), redirects followed by hand and re-validated, a short timeout and a small body cap.
export interface LinkPreview {
  url: string;
  domain: string;
  title?: string;
  siteName?: string;
  image?: string;
}

const TIMEOUT_MS = 4000;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; value: LinkPreview }>();

export const isPrivateIp = (ip: string): boolean => {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v) || v.startsWith("ff");
  }
  return true; // not an IP we understand: refuse
};

// Runs for every connection attempt, so a hostname that resolves to a private address at connect time is refused.
const safeLookup = ((hostname: string, options: any, cb: any) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err, address, family);
    const list: { address: string }[] = Array.isArray(address) ? address : [{ address: address as string }];
    if (list.length === 0 || list.some((a) => isPrivateIp(a.address))) return cb(new Error("Blocked address"), "", 4);
    cb(null, address, family);
  });
}) as net.LookupFunction;

const parseSafeUrl = (raw: string): URL | null => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateIp(host)) return null;
  return u;
};

// Facebook, Instagram, and LinkedIn serve OG metadata (including profile photos) only to known browser
// or social-crawler UAs. facebookexternalhit is Facebook's own scraper UA — both FB and Instagram
// whitelist it and return full og:image, og:title etc. that they block for generic custom UAs.
const UA_BY_HOST: Record<string, string> = {
  "facebook.com":  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "instagram.com": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "linkedin.com":  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
};

function uaFor(hostname: string): string {
  const bare = hostname.replace(/^www\./, "");
  return UA_BY_HOST[bare] ?? "Mozilla/5.0 (compatible; BeginsoLinkPreview/2.0; +https://beginso.com)";
}

const getOnce = (u: URL): Promise<{ status: number; location?: string; type: string; body: string }> =>
  new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: "GET",
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: {
          "User-Agent": uaFor(u.hostname),
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers["content-type"] ?? "");
        const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location, type, body: "" });
        }
        if (!/text\/html|application\/xhtml/i.test(type)) {
          res.destroy();
          return resolve({ status, type, body: "" });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          chunks.push(c);
          if (size >= MAX_BYTES) res.destroy(); // enough of the <head>; stop reading
        });
        const done = () => resolve({ status, type, body: Buffer.concat(chunks).toString("utf8") });
        res.on("end", done);
        res.on("close", done);
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const metaTags = (html: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (key && attrs.content && !(key in out)) out[key] = attrs.content;
  }
  return out;
};

export const parsePreview = (html: string, finalUrl: URL): Omit<LinkPreview, "url" | "domain"> => {
  const meta = metaTags(html.slice(0, MAX_BYTES));
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = decode(meta["og:title"] ?? meta["twitter:title"] ?? titleTag ?? "").slice(0, 200);
  const siteName = decode(meta["og:site_name"] ?? "").slice(0, 100);
  let image: string | undefined;
  const rawImage = meta["og:image"] ?? meta["twitter:image"];
  if (rawImage) {
    try {
      const img = new URL(decode(rawImage), finalUrl);
      // https only: an http image would be blocked as mixed content in the viewer anyway.
      if (img.protocol === "https:" && img.href.length <= 2048) image = img.href;
    } catch {
      /* ignore a malformed image URL */
    }
  }
  return { ...(title ? { title } : {}), ...(siteName ? { siteName } : {}), ...(image ? { image } : {}) };
};

export const getLinkPreview = async (raw: string): Promise<LinkPreview | null> => {
  let u = parseSafeUrl(raw);
  if (!u) return null;
  const key = u.href;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const base: LinkPreview = { url: u.href, domain: u.hostname.replace(/^www\./, "") };
  let value = base;
  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const res = await getOnce(u);
      if (res.status >= 300 && res.status < 400 && res.location) {
        const next = parseSafeUrl(new URL(res.location, u).href);
        if (!next) break;
        u = next;
        continue;
      }
      if (res.body) value = { ...base, ...parsePreview(res.body, u) };
      break;
    }
  } catch {
    // Unreachable, slow or blocked: the viewer still gets the domain and the link.
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
  return value;
};
