export interface ILoginLocation {
  city: string | null;
  region: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Helper to check if an IP address is a private/loopback/bogon IP.
 * Private ranges:
 * - 127.0.0.0/8 (Loopback)
 * - 10.0.0.0/8
 * - 172.16.0.0/12
 * - 192.168.0.0/16
 * - 169.254.0.0/16 (Link-local)
 * - ::1 (IPv6 Loopback), fe80::/10, fc00::/7
 */
export const isPrivateOrInvalidIp = (ipStr: string): boolean => {
  if (!ipStr || typeof ipStr !== "string") return true;
  const cleanIp = ipStr.trim();
  if (!cleanIp || cleanIp === "unknown" || cleanIp === "localhost") return true;

  // IPv4 checks
  if (cleanIp === "127.0.0.1" || cleanIp.startsWith("127.")) return true;
  if (cleanIp.startsWith("10.")) return true;
  if (cleanIp.startsWith("192.168.")) return true;
  if (cleanIp.startsWith("169.254.")) return true;

  const ipv4Match = cleanIp.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const first = parseInt(ipv4Match[1], 10);
    const second = parseInt(ipv4Match[2], 10);
    if (first === 172 && second >= 16 && second <= 31) return true;
  }

  // IPv6 checks
  if (cleanIp === "::1" || cleanIp === "0:0:0:0:0:0:0:1") return true;
  if (cleanIp.toLowerCase().startsWith("fe80:") || cleanIp.toLowerCase().startsWith("fc00:") || cleanIp.toLowerCase().startsWith("fd00:")) return true;

  return false;
};

/**
 * Resolves an IP address to approximate location (city, region, country, latitude, longitude).
 * Fire-and-forget helper: returns null on any error, timeout, or missing coordinates.
 */
export const resolveIpLocation = async (ipStr: string): Promise<ILoginLocation | null> => {
  try {
    if (isPrivateOrInvalidIp(ipStr)) {
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s strict timeout

    // HTTPS provider: the visitor's IP must not cross the internet in clear text.
    const url = `https://ipwho.is/${encodeURIComponent(ipStr)}?fields=success,country,region,city,latitude,longitude`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data: any = await response.json();
    if (
      data &&
      data.success === true &&
      typeof data.latitude === "number" &&
      typeof data.longitude === "number" &&
      !isNaN(data.latitude) &&
      !isNaN(data.longitude)
    ) {
      return {
        city: data.city || null,
        region: data.region || null,
        country: data.country || null,
        latitude: data.latitude,
        longitude: data.longitude,
      };
    }

    return null;
  } catch (err) {
    // Silently handle timeouts, network failures, or unparseable responses
    return null;
  }
};
