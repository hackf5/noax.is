// Loaded with --import so scripts/cloudflare.mjs talks to an in-memory Cloudflare.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const stateFile = process.env.FAKE_CLOUDFLARE_STATE;
const logFile = process.env.FAKE_CLOUDFLARE_LOG;
const load = () => JSON.parse(readFileSync(stateFile, "utf8"));
const save = (state) => writeFileSync(stateFile, JSON.stringify(state));
const ok = (result, extra = {}) => Response.json({ success: true, errors: [], result, ...extra });
const fail = (status, message, code = status) => Response.json({ success: false, errors: [{ code, message }] }, { status });

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
  if (path === "/graphql") {
    if (state.rejectAnalytics || new Headers(init.headers).get("Authorization") !== `Bearer ${process.env.FAKE_ANALYTICS_TOKEN}`) {
      return Response.json({ errors: [{ message: "Analytics scope rejected." }] });
    }
    return Response.json({ data: { viewer: { zones: [{ daily: [], pages: [], countries: [], browsers: [], operating_systems: [], devices: [] }] } } });
  }
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
  if (/\/zones\/[^/]+\/dns_records$/.test(path)) return paged((state.dns ?? []).filter(({ name }) => name === url.searchParams.get("name.exact")));
  if (path.startsWith(`${account}/r2/buckets`)) {
    if (state.r2Inactive) return fail(403, "Please enable R2 through the Cloudflare Dashboard.", 10042);
    state.buckets ??= {};
    if (path === `${account}/r2/buckets` && method === "POST") {
      const bucket = { name: body.name, storage_class: body.storageClass, jurisdiction: "default", domains: [], cors: [] };
      state.buckets[body.name] = bucket;
      save(state);
      return ok(bucket);
    }
    const [name, ...suffix] = path.slice(`${account}/r2/buckets/`.length).split("/");
    const bucket = state.buckets[name];
    if (!bucket) return fail(404, "NoSuchBucket", 10006);
    if (!suffix.length) return ok(bucket);
    if (suffix[0] === "cors") {
      if (method === "GET") return ok({ rules: bucket.cors });
      bucket.cors = body.rules;
      save(state);
      return ok({});
    }
    if (suffix.join("/") === "domains/managed") return ok({ enabled: Boolean(bucket.managed) });
    if (suffix.join("/") === "domains/custom") {
      if (method === "GET") return ok({ domains: bucket.domains });
      const domain = { ...body, status: { ownership: "active", ssl: state.pendingMediaTls ? "pending" : "active" } };
      bucket.domains.push(domain);
      (state.dns ??= []).push({ name: body.domain, type: "CNAME" });
      save(state);
      return ok(domain);
    }
  }
  const ruleset = /^\/zones\/[^/]+\/rulesets(.*)$/.exec(path);
  if (ruleset) {
    if (state.noCacheSettings) return fail(403, "Authentication error", 10000);
    const suffix = ruleset[1];
    if (suffix === "/phases/http_request_cache_settings/entrypoint") {
      return state.cacheRuleset ? ok(state.cacheRuleset) : fail(404, "Could not find entrypoint ruleset", 10003);
    }
    if (!suffix && method === "POST") {
      state.cacheRuleset = { ...body, id: "cache-1", rules: body.rules.map((rule) => ({ ...rule, id: "rule-1" })) };
      save(state);
      return ok(state.cacheRuleset);
    }
    if (suffix === `/${state.cacheRuleset.id}/rules` && method === "POST") {
      state.cacheRuleset.rules.push({ ...body, id: `rule-${state.cacheRuleset.rules.length + 1}` });
      save(state);
      return ok(state.cacheRuleset);
    }
    if (method === "PATCH" && suffix.startsWith(`/${state.cacheRuleset.id}/rules/`)) {
      const rule = state.cacheRuleset.rules.find(({ id }) => suffix.endsWith(`/${id}`));
      Object.assign(rule, body);
      save(state);
      return ok(state.cacheRuleset);
    }
  }
  return fail(404, `Unhandled ${method} ${path}`);
};

if (!existsSync(stateFile)) throw new Error("FAKE_CLOUDFLARE_STATE must point at an existing state file.");
