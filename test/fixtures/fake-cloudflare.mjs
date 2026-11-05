// Loaded with --import so scripts/cloudflare.mjs talks to an in-memory Cloudflare.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const stateFile = process.env.FAKE_CLOUDFLARE_STATE;
const logFile = process.env.FAKE_CLOUDFLARE_LOG;
const load = () => JSON.parse(readFileSync(stateFile, "utf8"));
const save = (state) => writeFileSync(stateFile, JSON.stringify(state));
const ok = (result, extra = {}) => Response.json({ success: true, errors: [], result, ...extra });
const fail = (status, message) => Response.json({ success: false, errors: [{ code: status, message }] }, { status });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  if (url.pathname === "/cdn-cgi/access/certs") {
    if (logFile) appendFileSync(logFile, `CERTS ${url.origin}\n`);
    return Response.json({ keys: [{ kid: "fake" }] });
  }
  const path = url.pathname.replace("/client/v4", "");
  if (logFile) appendFileSync(logFile, `${method} ${path}\n`);
  const state = load();
  const body = init.body ? JSON.parse(init.body) : undefined;
  const account = `/accounts/${state.account}`;
  const paged = (items) => {
    const size = Number(url.searchParams.get("per_page") ?? 100);
    const page = Number(url.searchParams.get("page") ?? 1);
    return ok(items.slice((page - 1) * size, page * size), { result_info: { total_count: items.length } });
  };

  if (path === "/zones") return ok(state.zones.filter((zone) => zone.name === url.searchParams.get("name")));
  if (path === `${account}/access/organizations`) {
    return state.organization ? ok(state.organization) : fail(404, "access.api.error.not_enabled");
  }
  if (path === `${account}/d1/database`) {
    if (method === "GET") return paged(state.databases);
    const database = { uuid: `db-${state.databases.length + 1}`, name: body.name };
    state.databases.push(database);
    save(state);
    return ok(database);
  }
  if (path === `${account}/access/apps`) {
    if (method === "GET") return paged(state.applications);
    const application = { id: `app-${state.applications.length + 1}`, aud: "fake-aud", name: body.name, domain: body.domain, policies: body.policies };
    state.applications.push(application);
    save(state);
    return ok(application);
  }
  const policies = /\/access\/apps\/([^/]+)\/policies$/.exec(path);
  if (policies) return ok(state.applications.find((application) => application.id === policies[1]).policies);
  if (path === `${account}/access/service_tokens`) {
    if (method === "GET") return paged(state.tokens.map(({ client_secret, ...token }) => token));
    const token = { id: `token-${state.tokens.length + 1}`, name: body.name, client_id: "fake-client-id", client_secret: "fake-secret", expires_at: "2027-11-05T00:00:00Z" };
    state.tokens.push(token);
    save(state);
    return ok(token);
  }
  const action = /\/access\/service_tokens\/([^/]+)\/(rotate|refresh)$/.exec(path);
  if (action) {
    const token = state.tokens.find((candidate) => candidate.id === action[1]);
    if (action[2] === "rotate") token.client_secret = "rotated-secret";
    else token.expires_at = "2028-11-05T00:00:00Z";
    save(state);
    return ok(token);
  }
  if (path === `${account}/workers/domains`) return ok(state.domains);
  if (/\/zones\/[^/]+\/workers\/routes$/.test(path)) return ok(state.routes);
  return fail(404, `Unhandled ${method} ${path}`);
};

if (!existsSync(stateFile)) throw new Error("FAKE_CLOUDFLARE_STATE must point at an existing state file.");
