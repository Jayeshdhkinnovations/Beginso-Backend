// Settings of the read-only Docker view (super admin Server page). Read from the environment on every call so a restart is the only
// thing needed to change them, and the tests can set them freely. Nothing here is ever echoed to a client: not the URL, not the names.
//
//   DOCKER_PROXY_URL           http(s)://host:port of a read-only Docker socket proxy (CONTAINERS=1, POST=0). No credentials, no path.
//   ADMIN_VISIBLE_CONTAINERS   comma separated container names the console may see. Anything else answers "not found".

export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export type DockerProxyConfig = { configured: true; baseUrl: string; allowed: string[] } | { configured: false; reason: string };

export function getDockerProxyConfig(env: NodeJS.ProcessEnv = process.env): DockerProxyConfig {
  const raw = String(env.DOCKER_PROXY_URL ?? "").trim();
  if (!raw) return { configured: false, reason: "DOCKER_PROXY_URL is not set." };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { configured: false, reason: "DOCKER_PROXY_URL is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { configured: false, reason: "DOCKER_PROXY_URL must start with http:// or https://." };
  if (url.username || url.password) return { configured: false, reason: "DOCKER_PROXY_URL must not contain a user name or password." };
  if (url.pathname !== "/" || url.search || url.hash) return { configured: false, reason: "DOCKER_PROXY_URL must be only a host and port, with no path." };

  const allowed = [
    ...new Set(
      String(env.ADMIN_VISIBLE_CONTAINERS ?? "")
        .split(",")
        .map((n) => n.trim())
        .filter((n) => CONTAINER_NAME_RE.test(n)),
    ),
  ];
  if (allowed.length === 0) return { configured: false, reason: "ADMIN_VISIBLE_CONTAINERS is empty." };

  return { configured: true, baseUrl: url.origin, allowed };
}
