import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readFile } from "node:fs/promises";
import { getMcpHeaders, getMcpUrl, sameOriginFetch } from "./mcp-headers.mjs";
import { daysUntil } from "./provisioning.mjs";
import { TRAFFIC_REPORT_TOOL, trafficReportSchema } from "../src/analytics.ts";

const EXPIRY_WARNING_DAYS = 30;

async function warnAboutExpiry() {
  let expiry;
  try {
    expiry = JSON.parse(await readFile(new URL("../.local/provisioning.json", import.meta.url), "utf8")).access_service_token_expires_at;
  } catch {
    return;
  }
  if (!expiry) return;
  const days = daysUntil(expiry);
  if (days < 0) console.error(`The Access service token expired on ${expiry}. Run npm run cloudflare:rotate.`);
  else if (days <= EXPIRY_WARNING_DAYS) console.warn(`The Access service token expires in ${days} days. Run npm run cloudflare:rotate.`);
}

const client = new Client({ name: "noax-connection-check", version: "0.1.0" });
let headers;
try {
  await warnAboutExpiry();
  const url = await getMcpUrl();
  headers = await getMcpHeaders();
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    fetch: sameOriginFetch(url.origin),
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  const site = JSON.parse(await readFile(new URL("../.local/site.json", import.meta.url), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return "{}";
  }));
  const requiredTools = ["create_post", "delete_post", "get_post", "list_posts", "update_post"];
  if (site.files) requiredTools.push("begin_file_upload", "get_file", "list_files", "delete_file");
  if (site.analytics) requiredTools.push(TRAFFIC_REPORT_TOOL);
  for (const required of requiredTools) {
    assert.ok(names.includes(required), `Publishing server is missing ${required}.`);
  }
  console.log(`Connected to ${url.href}`);
  console.log(`Available tools: ${names.join(", ")}`);
  if (site.analytics) {
    const report = await client.callTool({ name: TRAFFIC_REPORT_TOOL, arguments: { days: 1 } });
    assert.ok(!report.isError, report.structuredContent?.error?.message ?? "The analytics smoke report failed.");
    const checked = trafficReportSchema.safeParse(report.structuredContent);
    assert.ok(checked.success && checked.data.daily.length === 1, "The analytics smoke report had an unexpected shape.");
    console.log("Analytics smoke report passed. Publishing connection is ready.");
  } else {
    console.log("Publishing connection is ready. This check only discovered tools; it did not call them.");
  }
} catch (error) {
  let message = error.message;
  for (const value of Object.values(headers ?? {})) message = message.replaceAll(value, "[redacted]");
  console.error(`Noax connection check failed: ${message}`);
  if (message === "fetch failed") {
    console.error("The hostname may not be reachable yet. After a first deploy, this machine can take up to 30 minutes to see it. Wait, then run npm run mcp:check.");
  }
  process.exitCode = 1;
} finally {
  await client.close();
}
