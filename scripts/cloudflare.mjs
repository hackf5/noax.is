import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  assertHostsAvailable, assertInZone, assertSinglePolicy, discoverTeamDomain, findZone, listAll, normaliseTeamDomain,
} from "./provisioning.mjs";
import { assertCredentialsMatch, generate, mcpUrl, paths, readSite, resourceNames } from "./site-config.mjs";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const command = process.argv[2];
if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .local/cloudflare.env.");
if (!["inspect", "provision", "rotate"].includes(command)) throw new Error("Usage: cloudflare.mjs inspect|provision|rotate");

async function request(method, path, data) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    redirect: "error",
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { throw new Error(`${method} ${path}: HTTP ${response.status}, unexpected response`); }
  if (!response.ok || !body.success) {
    const errors = (body.errors ?? []).map((error) => `${error.code}: ${error.message}`).join("; ").replaceAll(token, "[redacted]");
    throw new Error(`${method} ${path}: HTTP ${response.status}: ${errors}`);
  }
  return body;
}

const api = async (method, path, data) => (await request(method, path, data)).result;
const list = (path) => listAll((pagePath) => request("GET", pagePath), path);

async function protectLocalFiles() {
  await mkdir(new URL(".local/", paths.base), { recursive: true });
  await chmod(new URL(".local/", paths.base), 0o700);
  await chmod(new URL(".local/cloudflare.env", paths.base), 0o600).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function credentialLines(site, serviceToken) {
  return [
    `NOAX_MCP_URL=${mcpUrl(site)}`,
    `NOAX_ACCESS_CLIENT_ID=${serviceToken.client_id}`,
    `NOAX_ACCESS_CLIENT_SECRET=${serviceToken.client_secret}`,
    "",
  ].join("\n");
}

async function readRecord() {
  try {
    return JSON.parse(await readFile(paths.provisioning, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeRecord(record) {
  await writeFile(paths.provisioning, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
}

const site = await readSite();
const names = resourceNames(site);
const accountPath = `/accounts/${account}`;
const tokens = await list(`${accountPath}/access/service_tokens`);

if (command === "rotate") {
  const existing = tokens.find((candidate) => candidate.name === names.serviceToken);
  if (!existing) throw new Error(`No Access service token named "${names.serviceToken}" was found.`);
  await protectLocalFiles();
  const rotated = await api("POST", `${accountPath}/access/service_tokens/${existing.id}/rotate`, {});
  if (!rotated.client_secret) throw new Error("Access did not return the new client secret.");
  await writeFile(paths.credentials, credentialLines(site, { client_id: existing.client_id, client_secret: rotated.client_secret }), { mode: 0o600 });
  await chmod(paths.credentials, 0o600);
  console.log("Rotated the Access client secret; credentials saved to .local/mcp.env (not printed).");
  const refreshed = await api("POST", `${accountPath}/access/service_tokens/${existing.id}/refresh`);
  await writeRecord({ ...await readRecord(), access_service_token_id: existing.id, access_service_token_expires_at: refreshed.expires_at });
  console.log(`The service token now expires at ${refreshed.expires_at}.`);
  process.exit(0);
}

const zone = await findZone(api, site.public_host, account);
assertInZone(site.mcp_host, zone);
const databases = await list(`${accountPath}/d1/database`);
const applications = await list(`${accountPath}/access/apps`);
const domains = await api("GET", `${accountPath}/workers/domains`);
const routes = await api("GET", `/zones/${zone.id}/workers/routes`);

if (command === "inspect") {
  console.log(JSON.stringify({
    zone: zone.name,
    databases: databases.map(({ uuid, name }) => ({ id: uuid, name })),
    access_applications: applications.map(({ id, name, domain }) => ({ id, name, domain })),
    service_tokens: tokens.map(({ id, name }) => ({ id, name })),
    worker_domains: domains.map(({ hostname, service }) => ({ hostname, service })),
    worker_routes: routes.map(({ pattern, script }) => ({ pattern, script })),
  }, null, 2));
  process.exit(0);
}

// Everything below stops rather than silently reassign an existing site or broaden an Access policy.
assertHostsAvailable({ hosts: [site.public_host, site.mcp_host], worker: names.worker, domains, routes });
let application = applications.find((app) => app.domain === site.mcp_host);
if (application && application.name !== names.accessApplication) throw new Error(`${site.mcp_host} already has another Access application.`);

const record = await readRecord();
const teamDomain = process.env.ACCESS_TEAM_DOMAIN || record.access_team_domain;
const issuer = teamDomain ? normaliseTeamDomain(teamDomain) : await discoverTeamDomain(api, accountPath);
const keysResponse = await fetch(`${issuer}/cdn-cgi/access/certs`, { redirect: "error" });
if (!keysResponse.ok || !(await keysResponse.json()).keys?.length) throw new Error("Unable to verify the Access team's signing-key endpoint.");

await protectLocalFiles();
await assertCredentialsMatch(site);
let credentials;
try { credentials = parseEnv(await readFile(paths.credentials, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }

let serviceToken = tokens.find((candidate) => candidate.name === names.serviceToken);
if (serviceToken && (!credentials || credentials.NOAX_ACCESS_CLIENT_ID !== serviceToken.client_id)) {
  throw new Error("The service token exists but its secret is unavailable locally. Restore .local/mcp.env, or run npm run cloudflare:rotate to issue a new secret.");
}
if (!serviceToken) {
  if (credentials) throw new Error("Local MCP credentials already exist without a matching remote token. Review them before provisioning.");
  serviceToken = await api("POST", `${accountPath}/access/service_tokens`, { name: names.serviceToken, duration: "8760h" });
  if (!serviceToken.client_id || !serviceToken.client_secret) throw new Error("Access did not return the new service-token credentials.");
  await writeFile(paths.credentials, credentialLines(site, serviceToken), { mode: 0o600, flag: "wx" });
  console.log("Created the Access service token; credentials saved to .local/mcp.env (not printed).");
}
await chmod(paths.credentials, 0o600);

if (!application) {
  application = await api("POST", `${accountPath}/access/apps`, {
    name: names.accessApplication,
    type: "self_hosted",
    domain: site.mcp_host,
    app_launcher_visible: false,
    session_duration: "24h",
    service_auth_401_redirect: false,
    policies: [{
      name: names.accessPolicy,
      decision: "non_identity",
      include: [{ service_token: { token_id: serviceToken.id } }],
      require: [], exclude: [],
    }],
  });
  console.log("Created the Access application and its Service Auth policy.");
}
assertSinglePolicy(await api("GET", `${accountPath}/access/apps/${application.id}/policies`), serviceToken.id);

let database = databases.find((candidate) => candidate.name === names.database);
if (!database) {
  database = await api("POST", `${accountPath}/d1/database`, { name: names.database });
  console.log(`Created the ${names.database} D1 database.`);
}
if (!database.uuid || !application.aud) throw new Error("Provisioning returned incomplete resource identifiers.");

await writeRecord({
  worker: names.worker,
  database_id: database.uuid,
  access_app_id: application.id,
  access_aud: application.aud,
  access_team_domain: issuer,
  access_service_token_id: serviceToken.id,
  access_service_token_expires_at: serviceToken.expires_at,
});
await generate();
console.log("Recorded the deployment in .local/ and generated the MCP client configs. Apply migrations before deploying.");
