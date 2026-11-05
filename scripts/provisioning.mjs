// Decisions behind provisioning, kept free of side effects so they can be tested.

export function zoneCandidates(host) {
  const labels = host.split(".");
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
}

// Tries blog.example.com, then example.com, so the most specific zone wins.
export async function findZone(api, host, account) {
  for (const name of zoneCandidates(host)) {
    const zones = await api("GET", `/zones?name=${encodeURIComponent(name)}`);
    const zone = zones.find((candidate) => candidate.name === name && candidate.account.id === account);
    if (zone?.status === "active") return zone;
  }
  throw new Error(`No active Cloudflare zone covering ${host} was found in the configured account.`);
}

export function assertInZone(host, zone) {
  if (host !== zone.name && !host.endsWith(`.${zone.name}`)) {
    throw new Error(`${host} is not in the ${zone.name} zone. Both hostnames must share a zone.`);
  }
}

export function routeMatchesHost(pattern, host) {
  const hostPattern = pattern.split("/")[0].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${hostPattern}$`).test(host);
}

// Stops rather than silently reassign another Worker's hostname. Unrelated Workers in the zone are fine.
export function assertHostsAvailable({ hosts, worker, domains, routes }) {
  for (const host of hosts) {
    const domain = domains.find((candidate) => candidate.hostname === host);
    if (domain && domain.service !== worker) throw new Error(`${host} already belongs to Worker ${domain.service}.`);
    const route = routes.find((candidate) => candidate.script && candidate.script !== worker && routeMatchesHost(candidate.pattern, host));
    if (route) throw new Error(`${host} is covered by route ${route.pattern} on Worker ${route.script}.`);
  }
}

export async function listAll(fetchPage, path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const { result, result_info: info } = await fetchPage(`${path}${separator}per_page=100&page=${page}`);
    const batch = Array.isArray(result) ? result : result?.service_tokens ?? [];
    items.push(...batch);
    if (!batch.length || !info?.total_count || items.length >= info.total_count) return items;
  }
}

export function normaliseTeamDomain(value) {
  const issuer = new URL(value.includes("://") ? value : `https://${value}`);
  if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.origin !== issuer.href.replace(/\/$/, "")) {
    throw new Error("ACCESS_TEAM_DOMAIN must be the HTTPS origin of your Cloudflare Access team.");
  }
  return issuer.origin;
}

// The team must come from the account being provisioned, never from a default in the repository.
export async function discoverTeamDomain(api, accountPath) {
  let organization;
  try {
    organization = await api("GET", `${accountPath}/access/organizations`);
  } catch (error) {
    throw new Error(
      "Could not read your Zero Trust organisation. Create one at https://one.dash.cloudflare.com, " +
      "check the token has Access: Organizations Read, or set ACCESS_TEAM_DOMAIN in .local/cloudflare.env. " +
      `(${error.message})`,
    );
  }
  if (!organization?.auth_domain) {
    throw new Error("This account has no Zero Trust organisation. Create one at https://one.dash.cloudflare.com, then run this again.");
  }
  return normaliseTeamDomain(organization.auth_domain);
}

export function assertSinglePolicy(policies, serviceTokenId) {
  if (
    policies.length !== 1 || policies[0].decision !== "non_identity" ||
    policies[0].include?.length !== 1 || policies[0].include[0].service_token?.token_id !== serviceTokenId
  ) throw new Error("The publishing Access application must contain only the designated service-token policy. Inspect its policies before deploying.");
}

export function daysUntil(timestamp, now = Date.now()) {
  return Math.floor((Date.parse(timestamp) - now) / 86_400_000);
}
