import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const command = process.argv[2];
if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
if (!['inspect', 'provision'].includes(command)) throw new Error("Usage: cloudflare.mjs inspect|provision");

async function api(method, path, data) {
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
  return body.result;
}

const accountPath = `/accounts/${account}`;
const configPath = new URL("../wrangler.jsonc", import.meta.url);
const config = JSON.parse(await readFile(configPath, "utf8"));
const zoneName = config.vars.PUBLIC_HOST;
const mcpHost = config.vars.MCP_HOST;
const zones = await api("GET", `/zones?name=${encodeURIComponent(zoneName)}`);
const zone = zones.find((candidate) => candidate.name === zoneName && candidate.account.id === account);
if (!zone || zone.status !== "active") throw new Error(`An active ${zoneName} zone was not found in the configured account.`);

const databases = await api("GET", `${accountPath}/d1/database?per_page=100`);
const applications = await api("GET", `${accountPath}/access/apps?per_page=100`);
const tokensResult = await api("GET", `${accountPath}/access/service_tokens?per_page=100`);
const tokens = Array.isArray(tokensResult) ? tokensResult : tokensResult.service_tokens;
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

// Stop rather than silently reassign an existing site or broaden an Access policy.
for (const hostname of [zoneName, mcpHost]) {
  const existing = domains.find((domain) => domain.hostname === hostname);
  if (existing && existing.service !== config.name) throw new Error(`${hostname} already belongs to Worker ${existing.service}.`);
}
if (routes.some((route) => route.script && route.script !== config.name)) {
  throw new Error(`The ${zoneName} zone has another Worker's routes. Review those before provisioning.`);
}
let application = applications.find((app) => app.domain === mcpHost);
if (application && application.name !== "noax.is publishing") throw new Error(`${mcpHost} already has another Access application.`);

const issuer = new URL(process.env.ACCESS_TEAM_DOMAIN || config.vars.ACCESS_TEAM_DOMAIN);
if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.origin !== issuer.href.replace(/\/$/, "")) {
  throw new Error("ACCESS_TEAM_DOMAIN must be the HTTPS origin of your Cloudflare Access team.");
}
const keysResponse = await fetch(`${issuer.origin}/cdn-cgi/access/certs`, { redirect: "error" });
if (!keysResponse.ok || !(await keysResponse.json()).keys?.length) throw new Error("Unable to verify the Access team's signing-key endpoint.");

await mkdir(new URL("../.local/", import.meta.url), { recursive: true, mode: 0o700 });
const credentialsPath = new URL("../.local/mcp.env", import.meta.url);
let credentials;
try { credentials = parseEnv(await readFile(credentialsPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }

let serviceToken = tokens.find((candidate) => candidate.name === "noax.is coding harness");
if (serviceToken && (!credentials || credentials.NOAX_ACCESS_CLIENT_ID !== serviceToken.client_id)) {
  throw new Error("The harness service token exists but its secret is unavailable locally. Restore .local/mcp.env or rotate the token deliberately.");
}
if (!serviceToken) {
  if (credentials) throw new Error("Local MCP credentials already exist without a matching remote token. Review them before provisioning.");
  serviceToken = await api("POST", `${accountPath}/access/service_tokens`, {
    name: "noax.is coding harness", duration: "8760h",
  });
  if (!serviceToken.client_id || !serviceToken.client_secret) throw new Error("Access did not return the new service-token credentials.");
  await writeFile(credentialsPath, [
    `NOAX_MCP_URL=https://${mcpHost}/mcp`,
    `NOAX_ACCESS_CLIENT_ID=${serviceToken.client_id}`,
    `NOAX_ACCESS_CLIENT_SECRET=${serviceToken.client_secret}`,
    "",
  ].join("\n"), { mode: 0o600, flag: "wx" });
  console.log("Created the Access service token; credentials saved to .local/mcp.env (not printed).");
}
await chmod(credentialsPath, 0o600);

if (!application) {
  application = await api("POST", `${accountPath}/access/apps`, {
    name: "noax.is publishing",
    type: "self_hosted",
    domain: mcpHost,
    app_launcher_visible: false,
    session_duration: "24h",
    service_auth_401_redirect: false,
    policies: [{
      name: "Allow the noax.is coding harness",
      decision: "non_identity",
      include: [{ service_token: { token_id: serviceToken.id } }],
      require: [], exclude: [],
    }],
  });
  console.log("Created the Access application and its Service Auth policy.");
}
const policies = await api("GET", `${accountPath}/access/apps/${application.id}/policies`);
if (
  policies.length !== 1 || policies[0].decision !== "non_identity" ||
  policies[0].include?.length !== 1 || policies[0].include[0].service_token?.token_id !== serviceToken.id
) throw new Error("The publishing Access application must contain only the designated service-token policy. Inspect its policies before deploying.");

let database = databases.find((candidate) => candidate.name === "noax-is");
if (!database) {
  database = await api("POST", `${accountPath}/d1/database`, { name: "noax-is" });
  console.log("Created the noax-is D1 database.");
}
config.d1_databases[0].database_id = database.uuid;
config.vars.ACCESS_TEAM_DOMAIN = issuer.origin;
config.vars.ACCESS_AUD = application.aud;
if (!database.uuid || !application.aud) throw new Error("Provisioning returned incomplete resource identifiers.");
await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
await writeFile(new URL("../.local/provisioning.json", import.meta.url), JSON.stringify({
  worker: config.name, database_id: database.uuid, access_app_id: application.id,
  access_service_token_id: serviceToken.id, access_service_token_expires_at: serviceToken.expires_at,
}, null, 2) + "\n", { mode: 0o600 });
console.log("Updated wrangler.jsonc with non-secret database and Access identifiers. Apply migrations before deploying.");
