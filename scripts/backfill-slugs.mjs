import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { backfillSlugs } from "../src/slug-backfill.ts";

const mode = process.argv[2];
if (process.argv.length !== 3 || !["--local", "--remote"].includes(mode)) {
  throw new Error("Usage: node scripts/backfill-slugs.mjs --local|--remote");
}

const configPath = new URL(mode === "--local" ? "../wrangler.jsonc" : "../.local/wrangler.deploy.jsonc", import.meta.url);
let query;
let dispose;
if (mode === "--local") {
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy({ configPath: fileURLToPath(configPath), envFiles: [], remoteBindings: false });
  dispose = platform.dispose;
  query = async (sql, params) => (await platform.env.DB.prepare(sql).bind(...params).all()).results;
} else {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const database = config.d1_databases.find((binding) => binding.binding === "DB")?.database_id;
  if (!/^[0-9a-f]{32}$/.test(account) || !/^[0-9a-f-]{36}$/.test(database ?? "")) {
    throw new Error("Invalid configured Cloudflare account or D1 database ID.");
  }
  query = async (sql, params) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params: params.map(String) }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (!response.ok || !body.success || !body.result?.[0]?.success || !Array.isArray(body.result[0].results)) {
      throw new Error(`D1 slug backfill query failed (HTTP ${response.status}).`);
    }
    return body.result[0].results;
  };
}

try {
  const updated = await backfillSlugs(query);
  const [result] = await query("SELECT count(*) AS missing FROM posts WHERE slug IS NULL", []);
  if (result.missing !== 0) throw new Error("Posts without slugs remain. Run the backfill again.");
  console.log(`Assigned slugs to ${updated} posts (${mode.slice(2)}); no posts without slugs remain.`);
} finally {
  await dispose?.();
}
