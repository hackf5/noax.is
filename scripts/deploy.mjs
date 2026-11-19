import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTrafficReport } from "../src/analytics.ts";
import { ANALYTICS_SECRET, generate, paths } from "./site-config.mjs";

async function localAnalyticsToken() {
  const source = await readFile(paths.analyticsSecrets, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (source === undefined) return;
  const malformed = `Set .local/analytics.secrets.json to a JSON object containing just ${ANALYTICS_SECRET}.`;
  let secrets;
  try { secrets = JSON.parse(source); } catch { throw new Error(malformed); }
  const token = secrets?.[ANALYTICS_SECRET];
  if (typeof token !== "string" || !token || /\s/.test(token) || Object.keys(secrets).length !== 1) {
    throw new Error(malformed);
  }
  await chmod(paths.analyticsSecrets, 0o600);
  return token;
}

let secretDir;
try {
  const { site, config } = await generate();
  console.log("Generated .local/wrangler.deploy.jsonc, .mcp.json and .codex/config.toml.");
  const args = ["--env-file=.local/cloudflare.env", "node_modules/wrangler/bin/wrangler.js", "deploy", "--config", ".local/wrangler.deploy.jsonc"];
  const token = site.analytics ? await localAnalyticsToken() : undefined;
  if (token) {
    await getTrafficReport({ zone: config.vars.ANALYTICS_ZONE_ID, hostname: site.public_host, token }, 1);
    console.log("Verified the read-only Cloudflare Analytics query.");
    // Upload the verified snapshot as literal JSON, even if the source file changes during deploy.
    secretDir = await mkdtemp(join(tmpdir(), "noax-analytics-"));
    const file = join(secretDir, "secrets.json");
    await writeFile(file, JSON.stringify({ [ANALYTICS_SECRET]: token }), { mode: 0o600 });
    args.push("--secrets-file", file);
  }
  const child = spawn(process.execPath, args, { cwd: new URL("../", import.meta.url), stdio: "inherit" });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (secretDir) await rm(secretDir, { recursive: true, force: true });
}
