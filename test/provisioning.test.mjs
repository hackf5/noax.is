import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertHostsAvailable, daysUntil, discoverTeamDomain, findZone, listAll, normaliseTeamDomain, routeMatchesHost, zoneCandidates,
} from "../scripts/provisioning.mjs";
import { buildDeployConfig, claudeConfig, codexConfig, resourceNames, validateSite } from "../scripts/site-config.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const fakeCloudflare = fileURLToPath(new URL("./fixtures/fake-cloudflare.mjs", import.meta.url));
const ACCOUNT = "fake-account";

describe("site configuration", () => {
  it("loads the slug backfill parser with Node's native TypeScript loader", async () => {
    await import("../src/slug-backfill.ts");
  });

  it("defaults everything except the public host", () => {
    assert.deepEqual(validateSite({ public_host: "blog.example.com" }), {
      public_host: "blog.example.com",
      mcp_host: "mcp.blog.example.com",
      title: "blog.example.com",
      description: "Notes on blog.example.com",
      locale: "en",
      content_signal: "search=yes, ai-input=yes",
    });
  });

  it("rejects unusable values", () => {
    assert.throws(() => validateSite({}), /public_host/);
    assert.throws(() => validateSite({ public_host: "localhost" }), /public_host/);
    assert.throws(() => validateSite({ public_host: "Blog.Example.com" }), /public_host/);
    assert.throws(() => validateSite({ public_host: "a.example", mcp_host: "a.example" }), /mcp_host/);
    assert.throws(() => validateSite({ public_host: "a.example", title: " " }), /title/);
    assert.throws(() => validateSite({ public_host: "a.example", locale: "not a locale" }), /locale/);
    for (const content_signal of ["", "search", "search=maybe", "search=yes,ai-train=no", 1, "search=yes\nDisallow: /", "search=yes\n"]) {
      assert.throws(() => validateSite({ public_host: "a.example", content_signal }), /content_signal/);
    }
  });

  it("accepts punycode top-level domains", () => {
    assert.equal(validateSite({ public_host: "blog.xn--p1ai" }).mcp_host, "mcp.blog.xn--p1ai");
  });

  it("derives the names the original noax.is deployment already uses", () => {
    assert.deepEqual(resourceNames(validateSite({ public_host: "noax.is", title: "A different title" })), {
      worker: "noax-is",
      database: "noax-is",
      accessApplication: "noax.is publishing",
      accessPolicy: "Allow the noax.is coding harness",
      serviceToken: "noax.is coding harness",
    });
  });

  it("builds a deploy config from the tracked config without inheriting its identity", () => {
    const base = JSON.parse(readFileSync(join(repo, "wrangler.jsonc"), "utf8"));
    const site = validateSite({ public_host: "blog.example.com", title: "Blog", description: "About", locale: "fr", content_signal: "search=yes, ai-train=yes" });
    const config = buildDeployConfig(base, site, { database_id: "db", access_aud: "aud", access_team_domain: "https://t.cloudflareaccess.com" });
    assert.equal(config.name, "blog-example-com");
    assert.equal(config.main, "../src/index.ts");
    assert.equal(config.$schema, undefined);
    assert.equal(config.compatibility_date, base.compatibility_date);
    assert.equal(config.workers_dev, false);
    assert.deepEqual(config.routes.map((route) => route.pattern), ["blog.example.com", "mcp.blog.example.com"]);
    assert.deepEqual(config.vars, {
      PUBLIC_HOST: "blog.example.com", MCP_HOST: "mcp.blog.example.com",
      ACCESS_TEAM_DOMAIN: "https://t.cloudflareaccess.com", ACCESS_AUD: "aud",
      SITE_TITLE: "Blog", SITE_DESCRIPTION: "About", SITE_LOCALE: "fr", SITE_CONTENT_SIGNAL: "search=yes, ai-train=yes",
    });
    assert.deepEqual(config.d1_databases, [{ binding: "DB", database_name: "blog-example-com", database_id: "db", migrations_dir: "../migrations" }]);
  });

  it("refuses to build a deploy config without provisioning data", () => {
    const base = JSON.parse(readFileSync(join(repo, "wrangler.jsonc"), "utf8"));
    assert.throws(() => buildDeployConfig(base, validateSite({ public_host: "a.example" }), { database_id: "db" }), /access_aud/);
  });

  it("requires a provisioned zone and an inherited or uploaded secret only for opt-in analytics", () => {
    const base = JSON.parse(readFileSync(join(repo, "wrangler.jsonc"), "utf8"));
    const record = { database_id: "db", access_aud: "aud", access_team_domain: "https://t.cloudflareaccess.com" };
    const site = { public_host: "blog.example.com" };
    assert.throws(() => validateSite({ ...site, analytics: "false" }), /analytics/);
    assert.throws(() => buildDeployConfig(base, validateSite({ ...site, analytics: true }), record), /zone ID/);
    const disabled = buildDeployConfig(base, validateSite({ ...site, analytics: false }), { ...record, zone_id: "zone-1" });
    assert.equal(disabled.vars.ANALYTICS_ZONE_ID, undefined);
    assert.equal(disabled.secrets, undefined);
    const enabled = buildDeployConfig(base, validateSite({ ...site, analytics: true }), { ...record, zone_id: "zone-1" });
    assert.equal(enabled.vars.ANALYTICS_ZONE_ID, "zone-1");
    assert.deepEqual(enabled.secrets.required, ["NOAX_ANALYTICS_TOKEN"]);
    assert.equal(enabled.vars.NOAX_ANALYTICS_TOKEN, undefined);
  });

  it("points both client configs at the configured host", () => {
    const site = validateSite({ public_host: "blog.example.com" });
    assert.equal(JSON.parse(claudeConfig(site)).mcpServers.noax.url, "https://mcp.blog.example.com/mcp");
    assert.match(codexConfig(site), /url = "https:\/\/mcp\.blog\.example\.com\/mcp"/);
  });

  it("keeps instance identity out of the tracked config", () => {
    const tracked = readFileSync(join(repo, "wrangler.jsonc"), "utf8");
    assert.doesNotMatch(tracked, /noax\.is|hackf5/);
    assert.equal(JSON.parse(tracked).routes, undefined);
  });
});

describe("zone lookup", () => {
  it("walks up from the most specific name and stops before the TLD", () => {
    assert.deepEqual(zoneCandidates("a.blog.example.com"), ["a.blog.example.com", "blog.example.com", "example.com"]);
    assert.deepEqual(zoneCandidates("noax.is"), ["noax.is"]);
  });

  const zoneApi = (zones) => async (_method, path) => {
    const name = new URL(path, "https://x").searchParams.get("name");
    return zones.filter((zone) => zone.name === name);
  };

  it("finds the parent zone of a subdomain", async () => {
    const zone = { name: "example.com", status: "active", account: { id: ACCOUNT } };
    assert.equal(await findZone(zoneApi([zone]), "blog.example.com", ACCOUNT), zone);
  });

  it("ignores zones in other accounts or not yet active", async () => {
    await assert.rejects(findZone(zoneApi([{ name: "example.com", status: "active", account: { id: "other" } }]), "example.com", ACCOUNT), /No active/);
    await assert.rejects(findZone(zoneApi([{ name: "example.com", status: "pending", account: { id: ACCOUNT } }]), "example.com", ACCOUNT), /No active/);
  });
});

describe("hostname guard", () => {
  it("matches route patterns against hostnames", () => {
    assert.equal(routeMatchesHost("blog.example.com/*", "blog.example.com"), true);
    assert.equal(routeMatchesHost("*.example.com/*", "blog.example.com"), true);
    assert.equal(routeMatchesHost("*example.com/*", "example.com"), true);
    assert.equal(routeMatchesHost("shop.example.com/*", "blog.example.com"), false);
    assert.equal(routeMatchesHost("blogxexample.com/*", "blog.example.com"), false);
  });

  const hosts = ["blog.example.com", "mcp.blog.example.com"];

  it("allows unrelated Workers in the same zone", () => {
    assert.doesNotThrow(() => assertHostsAvailable({
      hosts, worker: "mine",
      domains: [{ hostname: "shop.example.com", service: "other" }],
      routes: [{ pattern: "shop.example.com/*", script: "other" }],
    }));
  });

  it("stops if another Worker owns a target host", () => {
    assert.throws(() => assertHostsAvailable({ hosts, worker: "mine", domains: [{ hostname: "blog.example.com", service: "other" }], routes: [] }), /already belongs to Worker other/);
    assert.throws(() => assertHostsAvailable({ hosts, worker: "mine", domains: [], routes: [{ pattern: "*.example.com/*", script: "other" }] }), /covered by route/);
  });

  it("allows the instance's own bindings, so provisioning can be repeated", () => {
    assert.doesNotThrow(() => assertHostsAvailable({
      hosts, worker: "mine",
      domains: [{ hostname: "blog.example.com", service: "mine" }],
      routes: [{ pattern: "blog.example.com/*", script: "mine" }, { pattern: "*.example.com/*" }],
    }));
  });
});

describe("Cloudflare helpers", () => {
  it("follows pagination past the first page", async () => {
    const all = Array.from({ length: 250 }, (_, id) => ({ id }));
    const calls = [];
    const items = await listAll(async (path) => {
      calls.push(path);
      const url = new URL(path, "https://x");
      const page = Number(url.searchParams.get("page"));
      return { result: all.slice((page - 1) * 100, page * 100), result_info: { total_count: all.length } };
    }, "/things");
    assert.equal(items.length, 250);
    assert.equal(calls.length, 3);
  });

  it("stops after one page when the API reports no totals, and unwraps service tokens", async () => {
    assert.deepEqual(await listAll(async () => ({ result: { service_tokens: [{ id: 1 }] } }), "/tokens"), [{ id: 1 }]);
  });

  it("discovers the team from the account", async () => {
    const api = async () => ({ auth_domain: "my-team.cloudflareaccess.com" });
    assert.equal(await discoverTeamDomain(api, "/accounts/x"), "https://my-team.cloudflareaccess.com");
  });

  it("explains how to fix a missing organisation or permission", async () => {
    await assert.rejects(discoverTeamDomain(async () => ({}), "/accounts/x"), /no Zero Trust organisation/);
    await assert.rejects(discoverTeamDomain(async () => { throw new Error("HTTP 403"); }, "/accounts/x"), /Access: Organizations, Identity Providers, and Groups Read.*HTTP 403/s);
  });

  it("only accepts Cloudflare Access origins", () => {
    assert.equal(normaliseTeamDomain("https://t.cloudflareaccess.com/"), "https://t.cloudflareaccess.com");
    for (const value of ["http://t.cloudflareaccess.com", "https://evil.example", "https://t.cloudflareaccess.com/path"]) {
      assert.throws(() => normaliseTeamDomain(value), /ACCESS_TEAM_DOMAIN/);
    }
  });

  it("counts whole days to expiry", () => {
    assert.equal(daysUntil("2026-01-11T00:00:00Z", Date.parse("2026-01-01T00:00:00Z")), 10);
    assert.equal(daysUntil("2025-12-31T00:00:00Z", Date.parse("2026-01-01T00:00:00Z")), -1);
  });
});

describe("provisioning against a fake Cloudflare", () => {
  const workspaces = [];
  after(() => { for (const path of workspaces) rmSync(path, { recursive: true, force: true }); });

  function workspace({ site = { public_host: "blog.example.com" }, state = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "noax-provision-"));
    workspaces.push(dir);
    cpSync(join(repo, "scripts"), join(dir, "scripts"), { recursive: true });
    cpSync(join(repo, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
    mkdirSync(join(dir, ".local"));
    writeFileSync(join(dir, ".local/site.json"), JSON.stringify(site));
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      account: ACCOUNT,
      zones: [{ id: "zone-1", name: "example.com", status: "active", account: { id: ACCOUNT } }],
      organization: { auth_domain: "my-team.cloudflareaccess.com" },
      databases: [], applications: [], tokens: [], domains: [], routes: [],
      ...state,
    }));
    return dir;
  }

  function run(dir, command, env = {}) {
    const result = spawnSync(process.execPath, ["--import", fakeCloudflare, "scripts/cloudflare.mjs", command], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "fake-token",
        FAKE_CLOUDFLARE_STATE: join(dir, "state.json"), FAKE_CLOUDFLARE_LOG: join(dir, "log.txt"), ...env,
      },
    });
    return result;
  }

  const log = (dir) => (existsSync(join(dir, "log.txt")) ? readFileSync(join(dir, "log.txt"), "utf8") : "");
  const writes = (dir) => log(dir).split("\n").filter((line) => line.startsWith("POST"));
  const json = (dir, path) => JSON.parse(readFileSync(join(dir, path), "utf8"));

  function prepareDeploy(dir) {
    mkdirSync(join(dir, "src"));
    cpSync(join(repo, "src/analytics.ts"), join(dir, "src/analytics.ts"));
    mkdirSync(join(dir, "node_modules/wrangler/bin"), { recursive: true });
    symlinkSync(join(repo, "node_modules/zod"), join(dir, "node_modules/zod"));
    writeFileSync(join(dir, ".local/cloudflare.env"), "CLOUDFLARE_API_TOKEN=provisioning-fixture\n");
    writeFileSync(join(dir, "node_modules/wrangler/bin/wrangler.js"), `
      const { readFileSync, appendFileSync, statSync } = require("node:fs");
      const args = process.argv.slice(2);
      const config = JSON.parse(readFileSync(args[args.indexOf("--config") + 1]));
      const path = args.includes("--secrets-file") ? args[args.indexOf("--secrets-file") + 1] : undefined;
      const received = path && JSON.parse(readFileSync(path));
      if (path && (received.NOAX_ANALYTICS_TOKEN !== process.env.FAKE_ANALYTICS_TOKEN || (statSync(path).mode & 511) !== 384)) process.exit(2);
      appendFileSync("deployments.log", JSON.stringify({ required: config.secrets?.required ?? [], path, uploaded: Boolean(received) }) + "\\n");
    `);
  }

  function deploy(dir, token = "analytics-fixture-only") {
    return spawnSync(process.execPath, ["--import", fakeCloudflare, "scripts/deploy.mjs"], {
      cwd: dir, encoding: "utf8",
      env: { FAKE_CLOUDFLARE_STATE: join(dir, "state.json"), FAKE_CLOUDFLARE_LOG: join(dir, "log.txt"), FAKE_ANALYTICS_TOKEN: token },
    });
  }

  it("enables analytics after a text-only install and handles later inheritance and rotation", () => {
    const dir = workspace();
    assert.equal(run(dir, "provision").status, 0);
    prepareDeploy(dir);
    const path = join(dir, ".local/analytics.secrets.json");
    writeFileSync(path, "ignored for text-only setup");
    assert.equal(deploy(dir).status, 0);
    assert.doesNotMatch(log(dir), /POST \/graphql/);
    writeFileSync(join(dir, ".local/site.json"), JSON.stringify({ public_host: "blog.example.com", analytics: true }));
    assert.equal(run(dir, "provision").status, 0);
    assert.equal(json(dir, ".local/provisioning.json").zone_id, "zone-1");
    for (const token of ["analytics-fixture-only", "analytics-replacement-only"]) {
      writeFileSync(path, JSON.stringify({ NOAX_ANALYTICS_TOKEN: token }));
      const result = deploy(dir, token);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
    }
    rmSync(path);
    assert.equal(deploy(dir).status, 0);
    const deployments = readFileSync(join(dir, "deployments.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(deployments.map(({ uploaded }) => uploaded), [false, true, true, false]);
    assert.deepEqual(deployments.at(-1).required, ["NOAX_ANALYTICS_TOKEN"]);
    assert.ok(deployments.filter(({ path }) => path).every(({ path }) => !existsSync(path)));
  });

  it("provisions analytics on a fresh site and blocks deployment with an invalid or rejected token", () => {
    const dir = workspace({ site: { public_host: "blog.example.com", analytics: true }, state: { rejectAnalytics: true } });
    assert.equal(run(dir, "provision").status, 0);
    prepareDeploy(dir);
    const path = join(dir, ".local/analytics.secrets.json");
    writeFileSync(path, "NOAX_ANALYTICS_TOKEN=$CLOUDFLARE_API_TOKEN");
    const malformed = deploy(dir);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /JSON object containing just NOAX_ANALYTICS_TOKEN/);
    writeFileSync(path, JSON.stringify({ NOAX_ANALYTICS_TOKEN: "analytics-fixture-only" }));
    const rejected = deploy(dir);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Analytics Read scope/);
    assert.equal(existsSync(join(dir, "deployments.log")), false);
  });

  it("sets up a stranger's subdomain from nothing and writes every generated file", () => {
    const dir = workspace();
    const result = run(dir, "provision");
    assert.equal(result.status, 0, result.stderr);

    const deploy = json(dir, ".local/wrangler.deploy.jsonc");
    assert.equal(deploy.name, "blog-example-com");
    assert.equal(deploy.vars.ACCESS_TEAM_DOMAIN, "https://my-team.cloudflareaccess.com");
    assert.equal(deploy.vars.ACCESS_AUD, "fake-aud");
    assert.equal(deploy.d1_databases[0].database_id, "db-1");

    const expectedUrl = "https://mcp.blog.example.com/mcp";
    assert.equal(json(dir, ".mcp.json").mcpServers.noax.url, expectedUrl);
    assert.match(readFileSync(join(dir, ".codex/config.toml"), "utf8"), /mcp\.blog\.example\.com/);
    const credentials = readFileSync(join(dir, ".local/mcp.env"), "utf8");
    assert.match(credentials, new RegExp(`NOAX_MCP_URL=${expectedUrl}`));
    assert.equal(statSync(join(dir, ".local/mcp.env")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, ".local")).mode & 0o777, 0o700);

    assert.ok(log(dir).includes("CERTS https://my-team.cloudflareaccess.com"));
    assert.ok(!`${result.stdout}${result.stderr}`.includes("fake-secret"), "the secret must never be printed");
  });

  it("creates the service token before the application that references it", () => {
    const dir = workspace();
    run(dir, "provision");
    const order = writes(dir).map((line) => line.split("/").at(-1));
    assert.deepEqual(order, ["service_tokens", "apps", "database"]);
  });

  it("creates nothing on a second run", () => {
    const dir = workspace();
    assert.equal(run(dir, "provision").status, 0);
    const before = writes(dir).length;
    const second = run(dir, "provision");
    assert.equal(second.status, 0, second.stderr);
    assert.equal(writes(dir).length, before);
  });

  const files = { bucket_name: "blog-files", media_host: "media.example.com" };
  const filesSite = { public_host: "blog.example.com", files };
  const cloudflareWrites = (dir) => log(dir).split("\n").filter((line) => /^(POST|PUT|PATCH|DELETE) /.test(line));

  it("provisions one bucket, CORS policy and scoped Cache Rule on a fresh files installation", () => {
    const dir = workspace({ site: filesSite, state: { pendingMediaTls: true } });
    const inspection = run(dir, "inspect");
    assert.equal(inspection.status, 0, inspection.stderr);
    assert.equal(JSON.parse(inspection.stdout).files.bucket_exists, false);
    assert.deepEqual(cloudflareWrites(dir), []);
    const result = run(dir, "provision");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DNS or TLS is still activating/);
    const config = json(dir, ".local/wrangler.deploy.jsonc");
    assert.deepEqual(config.r2_buckets, [{ binding: "FILES", bucket_name: "blog-files" }]);
    assert.equal(config.vars.MEDIA_HOST, files.media_host);
    assert.ok(config.routes.every(({ pattern }) => pattern !== files.media_host));
    const state = json(dir, "state.json");
    assert.deepEqual(state.buckets[files.bucket_name].cors, [{ id: "noax-media", allowed: { origins: ["*"], methods: ["GET", "HEAD"] } }]);
    assert.equal(state.buckets[files.bucket_name].domains[0].domain, files.media_host);
    const [rule] = state.cacheRuleset.rules;
    assert.equal(rule.expression, 'http.host eq "media.example.com"');
    assert.deepEqual(rule.action_parameters, {
      cache: true,
      edge_ttl: { mode: "respect_origin", status_code_ttl: [{ status_code: 404, value: -1 }] },
      browser_ttl: { mode: "respect_origin" },
    });
    const firstWrites = cloudflareWrites(dir);
    const repeat = run(dir, "provision");
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.deepEqual(cloudflareWrites(dir), firstWrites);
  });

  it("adds files to an existing blog and updates only its own cache rule", () => {
    const unrelated = { id: "rule-1", ref: "elsewhere", expression: 'http.host eq "docs.example.com"', enabled: true };
    const dir = workspace({ state: { cacheRuleset: { id: "cache-1", rules: [unrelated] } } });
    assert.equal(run(dir, "provision").status, 0);
    assert.doesNotMatch(log(dir), /\/r2\/|\/rulesets\/|\/dns_records/);
    const record = json(dir, ".local/provisioning.json");
    const credentials = readFileSync(join(dir, ".local/mcp.env"), "utf8");
    writeFileSync(join(dir, ".local/site.json"), JSON.stringify(filesSite));
    const upgrade = run(dir, "provision");
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.deepEqual(json(dir, ".local/provisioning.json"), { ...record, files });
    assert.equal(readFileSync(join(dir, ".local/mcp.env"), "utf8"), credentials);
    const state = json(dir, "state.json");
    assert.deepEqual(state.cacheRuleset.rules[0], unrelated);
    state.cacheRuleset.rules[1].enabled = false;
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    const fix = run(dir, "provision");
    assert.equal(fix.status, 0, fix.stderr);
    assert.deepEqual(json(dir, "state.json").cacheRuleset.rules, [unrelated, { ...state.cacheRuleset.rules[1], enabled: true }]);
  });

  it("reports missing R2 activation, Cache Settings access and host conflicts before writing", () => {
    for (const [state, message] of [
      [{ r2Inactive: true }, /Activate R2/],
      [{ noCacheSettings: true }, /Zone Cache Settings Edit/],
      [{ dns: [{ name: files.media_host, type: "A" }] }, /already configured/],
      [{ routes: [{ pattern: "*.example.com/*", script: "blog-example-com" }] }, /must be a separate media hostname/],
    ]) {
      const dir = workspace({ site: filesSite, state });
      const result = run(dir, "provision");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.deepEqual(cloudflareWrites(dir), []);
    }
  });

  it("adopts an existing instance without creating or renaming anything", () => {
    const dir = workspace({
      site: { public_host: "example.com", mcp_host: "mcp.example.com" },
      state: {
        databases: [{ uuid: "existing-db", name: "example-com" }],
        tokens: [{ id: "token-1", name: "example.com coding harness", client_id: "existing-id" }],
        applications: [{
          id: "app-1", aud: "existing-aud", name: "example.com publishing", domain: "mcp.example.com",
          policies: [{ decision: "non_identity", include: [{ service_token: { token_id: "token-1" } }] }],
        }],
        domains: [{ hostname: "example.com", service: "example-com" }, { hostname: "mcp.example.com", service: "example-com" }],
      },
    });
    writeFileSync(join(dir, ".local/mcp.env"), "NOAX_MCP_URL=https://mcp.example.com/mcp\nNOAX_ACCESS_CLIENT_ID=existing-id\nNOAX_ACCESS_CLIENT_SECRET=s\n");
    const result = run(dir, "provision");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(writes(dir), []);
    assert.equal(json(dir, ".local/wrangler.deploy.jsonc").vars.ACCESS_AUD, "existing-aud");
  });

  it("never falls back to a team in the repository", () => {
    const dir = workspace({ state: { organization: null } });
    const result = run(dir, "provision");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Zero Trust organisation/);
    assert.deepEqual(writes(dir), []);
    assert.ok(!log(dir).includes("CERTS"));
  });

  it("honours the ACCESS_TEAM_DOMAIN override", () => {
    const dir = workspace({ state: { organization: null } });
    assert.equal(run(dir, "provision", { ACCESS_TEAM_DOMAIN: "https://override.cloudflareaccess.com" }).status, 0);
    assert.equal(json(dir, ".local/wrangler.deploy.jsonc").vars.ACCESS_TEAM_DOMAIN, "https://override.cloudflareaccess.com");
  });

  it("stops before creating anything if another Worker owns the host", () => {
    const dir = workspace({ state: { domains: [{ hostname: "blog.example.com", service: "someone-else" }] } });
    const result = run(dir, "provision");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already belongs to Worker someone-else/);
    assert.deepEqual(writes(dir), []);
  });

  it("refuses credentials recorded for a different host", () => {
    const dir = workspace();
    writeFileSync(join(dir, ".local/mcp.env"), "NOAX_MCP_URL=https://mcp.other.example/mcp\nNOAX_ACCESS_CLIENT_ID=a\nNOAX_ACCESS_CLIENT_SECRET=b\n");
    const result = run(dir, "provision");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is for https:\/\/mcp\.other\.example\/mcp/);
    assert.deepEqual(writes(dir), []);
  });

  it("points a lost secret at the rotate command", () => {
    const dir = workspace({ state: { tokens: [{ id: "token-1", name: "blog.example.com coding harness", client_id: "existing-id" }] } });
    const result = run(dir, "provision");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cloudflare:rotate/);
  });

  it("rotates a lost or expiring token and records the new expiry", () => {
    const dir = workspace();
    assert.equal(run(dir, "provision").status, 0);
    const result = run(dir, "rotate");
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(dir, ".local/mcp.env"), "utf8"), /NOAX_ACCESS_CLIENT_SECRET=rotated-secret/);
    assert.equal(statSync(join(dir, ".local/mcp.env")).mode & 0o777, 0o600);
    assert.equal(json(dir, ".local/provisioning.json").access_service_token_expires_at, "2028-11-05T00:00:00Z");
    assert.ok(!`${result.stdout}${result.stderr}`.includes("rotated-secret"), "the secret must never be printed");
  });

  it("rotates with a token that can't see the zone", () => {
    const dir = workspace();
    assert.equal(run(dir, "provision").status, 0);
    const state = json(dir, "state.json");
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...state, zones: [] }));
    const result = run(dir, "rotate");
    assert.equal(result.status, 0, result.stderr);
  });

  it("inspects without writing anything or needing a Zero Trust organisation", () => {
    const dir = workspace({ state: { organization: null } });
    const result = run(dir, "inspect");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).zone, "example.com");
    assert.deepEqual(writes(dir), []);
    assert.ok(!existsSync(join(dir, ".local/provisioning.json")));
  });
});
