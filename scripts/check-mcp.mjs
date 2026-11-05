import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readFile } from "node:fs/promises";
import { getMcpHeaders, getMcpUrl } from "./mcp-headers.mjs";
import { daysUntil } from "./provisioning.mjs";

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
    requestInit: { headers, redirect: "error" },
    fetch(input, init) {
      const target = new URL(input instanceof Request ? input.url : input);
      if (target.origin !== url.origin) throw new Error("Refusing to send Noax credentials to another origin.");
      return fetch(input, { ...init, redirect: "error" });
    },
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  for (const required of ["create_post", "delete_post", "get_post", "list_posts", "update_post"]) {
    assert.ok(names.includes(required), `Publishing server is missing ${required}.`);
  }
  console.log(`Connected to ${url.href}`);
  console.log(`Available tools: ${names.join(", ")}`);
  console.log("Publishing connection is ready. This check only discovered tools; it did not call them.");
} catch (error) {
  let message = error.message;
  for (const value of Object.values(headers ?? {})) message = message.replaceAll(value, "[redacted]");
  console.error(`Noax connection check failed: ${message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
