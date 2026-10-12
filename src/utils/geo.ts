import geoip from "geoip-lite";

/**
 * Where a response came from, as coarse as the dashboard map needs: country, region, city and a position rounded to
 * 2 decimals (about 1 km). The raw IP is never stored; it is looked up here (offline, against the bundled GeoLite
 * database) and thrown away. Private / loopback / unknown addresses have no location, so local testing records none.
 */
export interface ResponseGeo {
  country: string;
  region?: string;
  city?: string;
  lat: number;
  lng: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

export const lookupGeo = (ip: string | undefined | null): ResponseGeo | null => {
  if (!ip || ip === "unknown") return null;
  // IPv4-mapped IPv6 ("::ffff:1.2.3.4") -> plain IPv4.
  const clean = ip.replace(/^::ffff:/i, "").trim();
  const hit = geoip.lookup(clean);
  if (!hit || !hit.country || !Array.isArray(hit.ll) || hit.ll.length !== 2) return null;
  const [lat, lng] = hit.ll;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    country: hit.country,
    ...(hit.region ? { region: hit.region } : {}),
    ...(hit.city ? { city: hit.city } : {}),
    lat: round(lat),
    lng: round(lng),
  };
};
