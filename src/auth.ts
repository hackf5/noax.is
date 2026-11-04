import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./types";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  try {
    const issuer = new URL(env.ACCESS_TEAM_DOMAIN);
    if (
      issuer.protocol !== "https:" ||
      !issuer.hostname.endsWith(".cloudflareaccess.com") ||
      issuer.username || issuer.password || issuer.port || issuer.pathname !== "/" || issuer.search || issuer.hash
    ) return false;
    const origin = issuer.origin;
    let keys = keySets.get(origin);
    if (!keys) {
      keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", origin));
      keySets.set(origin, keys);
    }
    await jwtVerify(token, keys, {
      issuer: origin,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
    });
    return true;
  } catch {
    return false;
  }
}
