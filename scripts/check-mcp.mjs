import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getMcpHeaders } from "./mcp-headers.mjs";

const url = new URL("https://mcp.noax.is/mcp");
const client = new Client({ name: "noax-is-connection-check", version: "0.1.0" });
let headers;
try {
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
