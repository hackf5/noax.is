import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertInZone, routeMatchesHost } from "./provisioning.mjs";

const CACHE_PHASE = "http_request_cache_settings";
const CORS = { id: "noax-media", allowed: { origins: ["*"], methods: ["GET", "HEAD"] } };

async function optionalGet(api, path) {
  try {
    return await api("GET", path);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

function desiredRule(host) {
  return {
    ref: `noax_files_${createHash("sha256").update(host).digest("hex").slice(0, 16)}`,
    description: `noax immutable media for ${host}`,
    expression: `http.host eq ${JSON.stringify(host)}`,
    action: "set_cache_settings",
    enabled: true,
    action_parameters: {
      cache: true,
      edge_ttl: { mode: "respect_origin", status_code_ttl: [{ status_code: 404, value: -1 }] },
      browser_ttl: { mode: "respect_origin" },
    },
  };
}

function ruleMatches(current, wanted) {
  const actual = current?.action_parameters;
  return current?.action === wanted.action && current.expression === wanted.expression && current.enabled === true &&
    actual?.cache === true && actual.edge_ttl?.mode === "respect_origin" && actual.browser_ttl?.mode === "respect_origin" &&
    isDeepStrictEqual(actual.edge_ttl?.status_code_ttl, wanted.action_parameters.edge_ttl.status_code_ttl);
}

export async function inspectFileStorage(api, accountPath, zone, files, workerDomains, workerRoutes) {
  const { bucket_name: name, media_host: host } = files;
  assertInZone(host, zone);
  if (host === zone.name || workerDomains.some(({ hostname }) => hostname === host) ||
      workerRoutes.some(({ pattern, script }) => script && routeMatchesHost(pattern, host))) {
    throw new Error(`${host} must be a separate media hostname with no Worker domain or matching Worker route.`);
  }
  const bucketPath = `${accountPath}/r2/buckets/${name}`;
  const zonePath = `/zones/${zone.id}`;
  let bucket;
  let ruleset;
  let dns;
  try {
    [bucket, ruleset, dns] = await Promise.all([
      optionalGet(api, bucketPath),
      optionalGet(api, `${zonePath}/rulesets/phases/${CACHE_PHASE}/entrypoint`),
      api("GET", `${zonePath}/dns_records?name.exact=${encodeURIComponent(host)}`),
    ]);
  } catch (error) {
    if (error.codes?.includes(10042)) {
      throw new Error("Activate R2 in the Cloudflare dashboard, then rerun setup.");
    }
    if (error.status === 403) {
      throw new Error(`Check the provisioning token has Workers R2 Storage Edit, Zone DNS Read and Zone Cache Settings Edit. ${error.message}`);
    }
    throw error;
  }
  let domain;
  let cors = [];
  if (bucket) {
    if (bucket.storage_class !== "Standard" || bucket.jurisdiction !== "default") {
      throw new Error(`Use a Standard R2 bucket in the default jurisdiction for ${name}.`);
    }
    const [custom, managed, policy] = await Promise.all([
      api("GET", `${bucketPath}/domains/custom`),
      api("GET", `${bucketPath}/domains/managed`),
      optionalGet(api, `${bucketPath}/cors`),
    ]);
    domain = custom.domains.find((entry) => entry.domain === host);
    cors = policy?.rules ?? [];
    if (managed.enabled || custom.domains.some((entry) => entry.enabled && entry.domain !== host)) {
      throw new Error(`Use a dedicated R2 bucket with ${host} as its only public hostname. Review existing domains on ${name}.`);
    }
  }
  if ((!domain && dns.some((record) => record.name === host)) || (domain?.zoneId && domain.zoneId !== zone.id)) {
    throw new Error(`${host} is already configured for another resource.`);
  }
  const rule = desiredRule(host);
  const existingRule = ruleset?.rules?.find(({ ref }) => ref === rule.ref);
  return { zonePath, bucketPath, bucket, domain, cors, ruleset, rule, existingRule };
}

export async function provisionFileStorage(api, zone, files, state) {
  const { bucketPath, zonePath, bucket, cors, rule, existingRule, ruleset } = state;
  const { bucket_name: name, media_host: host } = files;
  if (!bucket) await api("POST", bucketPath.slice(0, bucketPath.lastIndexOf("/")), { name, storageClass: "Standard" });

  const currentCors = cors.find(({ id }) => id === CORS.id);
  if (!isDeepStrictEqual(currentCors?.allowed?.origins, CORS.allowed.origins) ||
      !isDeepStrictEqual(currentCors?.allowed?.methods?.toSorted(), CORS.allowed.methods)) {
    await api("PUT", `${bucketPath}/cors`, { rules: [CORS, ...cors.filter(({ id }) => id !== CORS.id)] });
  }
  if (!ruleset) {
    await api("POST", `${zonePath}/rulesets`, { name: "Zone Cache Rules", kind: "zone", phase: CACHE_PHASE, rules: [rule] });
  } else if (!existingRule) {
    await api("POST", `${zonePath}/rulesets/${ruleset.id}/rules`, rule);
  } else if (!ruleMatches(existingRule, rule)) {
    await api("PATCH", `${zonePath}/rulesets/${ruleset.id}/rules/${existingRule.id}`, rule);
  }

  const domainPath = `${bucketPath}/domains/custom/${host}`;
  let domain = state.domain;
  if (!domain) domain = await api("POST", `${bucketPath}/domains/custom`, { domain: host, zoneId: zone.id, enabled: true });
  else if (!domain.enabled) domain = await api("PUT", domainPath, { enabled: true });
  if (!domain.status) domain = await api("GET", domainPath);
  if ([domain.status?.ownership, domain.status?.ssl].some((status) => ["blocked", "error"].includes(status))) {
    throw new Error(`${host} DNS or TLS is blocked. Check its R2 custom domain status.`);
  }
  if (domain.status?.ownership !== "active" || domain.status.ssl !== "active") {
    console.log(`${host} DNS or TLS is still activating. Check its status with npm run cloudflare:inspect before verifying media URLs.`);
  }
  return files;
}
