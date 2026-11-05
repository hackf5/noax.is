import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])$/;
const CONTENT_SIGNAL = /^[a-z-]+=(yes|no)(, [a-z-]+=(yes|no))*$/;

export const paths = {
  base: new URL("wrangler.jsonc", root),
  site: new URL(".local/site.json", root),
  provisioning: new URL(".local/provisioning.json", root),
  credentials: new URL(".local/mcp.env", root),
  deploy: new URL(".local/wrangler.deploy.jsonc", root),
  claude: new URL(".mcp.json", root),
  codexDir: new URL(".codex/", root),
  codex: new URL(".codex/config.toml", root),
};

export function validateSite(input) {
  const publicHost = input?.public_host;
  if (typeof publicHost !== "string" || !HOSTNAME.test(publicHost)) {
    throw new Error("Set public_host in .local/site.json to a lowercase hostname such as blog.example.com.");
  }
  const site = {
    public_host: publicHost,
    mcp_host: input.mcp_host ?? `mcp.${publicHost}`,
    title: input.title ?? publicHost,
    description: input.description ?? `Notes on ${input.title ?? publicHost}`,
    locale: input.locale ?? "en",
    content_signal: input.content_signal ?? "search=yes, ai-input=yes",
  };
  if (typeof site.mcp_host !== "string" || !HOSTNAME.test(site.mcp_host) || site.mcp_host === publicHost) {
    throw new Error("Set mcp_host in .local/site.json to a hostname different from public_host.");
  }
  for (const key of ["title", "description"]) {
    if (typeof site[key] !== "string" || !site[key].trim()) throw new Error(`Set a non-empty ${key} in .local/site.json.`);
  }
  try {
    new Intl.DateTimeFormat(site.locale);
  } catch {
    throw new Error(`locale in .local/site.json is not a valid language tag: ${site.locale}`);
  }
  // This goes straight into robots.txt, so it mustn't be able to add lines of its own.
  if (typeof site.content_signal !== "string" || !CONTENT_SIGNAL.test(site.content_signal)) {
    throw new Error("Set content_signal in .local/site.json to pairs such as search=yes, ai-input=yes.");
  }
  return site;
}

// noax.is gives noax-is, noax.is publishing and noax.is coding harness.
export function resourceNames(site) {
  const worker = site.public_host.replaceAll(".", "-");
  return {
    worker,
    database: worker,
    accessApplication: `${site.public_host} publishing`,
    accessPolicy: `Allow the ${site.public_host} coding harness`,
    serviceToken: `${site.public_host} coding harness`,
  };
}

export const mcpUrl = (site) => `https://${site.mcp_host}/mcp`;

// The generated file sits in .local/, so paths from the tracked config move up a level.
export function buildDeployConfig(base, site, provisioning) {
  for (const key of ["database_id", "access_aud", "access_team_domain"]) {
    if (!provisioning?.[key]) throw new Error(`.local/provisioning.json has no ${key}. Run npm run cloudflare:provision.`);
  }
  const { $schema, ...config } = base;
  const names = resourceNames(site);
  const [database] = base.d1_databases;
  return {
    ...config,
    name: names.worker,
    main: `../${base.main}`,
    routes: [
      { pattern: site.public_host, custom_domain: true },
      { pattern: site.mcp_host, custom_domain: true },
    ],
    vars: {
      ...base.vars,
      PUBLIC_HOST: site.public_host,
      MCP_HOST: site.mcp_host,
      ACCESS_TEAM_DOMAIN: provisioning.access_team_domain,
      ACCESS_AUD: provisioning.access_aud,
      SITE_TITLE: site.title,
      SITE_DESCRIPTION: site.description,
      SITE_LOCALE: site.locale,
      SITE_CONTENT_SIGNAL: site.content_signal,
    },
    d1_databases: [{
      ...database,
      database_name: names.database,
      database_id: provisioning.database_id,
      migrations_dir: `../${database.migrations_dir}`,
    }],
  };
}

export function claudeConfig(site) {
  return JSON.stringify({
    mcpServers: { noax: { type: "http", url: mcpUrl(site), headersHelper: "node scripts/mcp-headers.mjs" } },
  }, null, 2) + "\n";
}

export function codexConfig(site) {
  return `[mcp_servers.noax]\nurl = ${JSON.stringify(mcpUrl(site))}\nhttp_headers_helper = "node scripts/mcp-headers.mjs"\n`;
}

async function readJson(path, missing) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(missing);
    throw error;
  }
}

export async function readSite() {
  return validateSite(await readJson(paths.site, "Copy site.example.json to .local/site.json and set your hostnames."));
}

export function readProvisioning() {
  return readJson(paths.provisioning, "Run npm run cloudflare:provision before deploying.");
}

// Credentials only ever go to the URL recorded beside them, so a client config can't send them elsewhere.
export async function assertCredentialsMatch(site) {
  let credentials;
  try {
    credentials = parseEnv(await readFile(paths.credentials, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (credentials.NOAX_MCP_URL !== mcpUrl(site)) {
    throw new Error(`.local/mcp.env is for ${credentials.NOAX_MCP_URL}, but .local/site.json expects ${mcpUrl(site)}. Review both before continuing.`);
  }
}

export async function generate() {
  const site = await readSite();
  await assertCredentialsMatch(site);
  const config = buildDeployConfig(JSON.parse(await readFile(paths.base, "utf8")), site, await readProvisioning());
  await writeFile(paths.deploy, JSON.stringify(config, null, 2) + "\n");
  await writeFile(paths.claude, claudeConfig(site));
  await mkdir(paths.codexDir, { recursive: true });
  await writeFile(paths.codex, codexConfig(site));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await generate();
    console.log("Generated .local/wrangler.deploy.jsonc, .mcp.json and .codex/config.toml.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
