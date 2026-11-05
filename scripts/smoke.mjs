import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

if (!process.env.NOAX_MCP_URL) throw new Error("Load NOAX_MCP_URL from .local/mcp.env.");
const mcpUrl = new URL(process.env.NOAX_MCP_URL);
if (mcpUrl.protocol !== "https:" || mcpUrl.pathname !== "/mcp") {
  throw new Error("NOAX_MCP_URL must be an https URL ending in /mcp.");
}
const clientId = process.env.NOAX_ACCESS_CLIENT_ID;
const clientSecret = process.env.NOAX_ACCESS_CLIENT_SECRET;
if (!clientId || !clientSecret) throw new Error("Load NOAX_ACCESS_CLIENT_ID and NOAX_ACCESS_CLIENT_SECRET from .local/mcp.env.");
const client = new Client({ name: "noax-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: { headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret } },
  fetch: (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input);
    if (target.origin !== mcpUrl.origin) throw new Error("Refusing to send MCP credentials to another origin.");
    return fetch(input, { ...init, redirect: "error" });
  },
});
let created;
let deleted = false;
let connected = false;
let creationAttempted = false;
const marker = `Temporary deployment verification ${crypto.randomUUID()}`;
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, `${name} failed: ${JSON.stringify(response.structuredContent)}`);
  return response.structuredContent;
}
try {
  const denied = await fetch(mcpUrl, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.ok([401, 403].includes(denied.status), `Unauthenticated MCP should be blocked; received ${denied.status}`);
  await client.connect(transport);
  connected = true;
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["create_post", "delete_post", "get_post", "list_posts", "update_post"]);
  creationAttempted = true;
  created = (await call("create_post", { markdown: `${marker}\n\nA **Markdown** verification post; removed by the deployment check.` })).post;
  assert.equal(created.version, 1);
  let page = await fetch(created.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<strong>Markdown<\/strong>/);
  console.log("MCP authentication, discovery, publishing and public Markdown rendering passed.");
  // Only a live check shows that nothing at the edge changes these.
  const source = await fetch(created.url, { headers: { Accept: "text/markdown" } });
  assert.match(source.headers.get("Content-Type"), /^text\/markdown/);
  assert.match(await source.text(), /A \*\*Markdown\*\* verification post/);
  const { origin } = new URL(created.url);
  const robots = await (await fetch(`${origin}/robots.txt`)).text();
  assert.ok(robots.split("\n").includes(`Sitemap: ${origin}/sitemap.xml`), "robots.txt lost its Sitemap line");
  assert.match(await (await fetch(`${origin}/sitemap.xml`)).text(), /sitemap-pages\.xml/);
  assert.equal((await fetch(`${origin}/llms.txt`)).status, 200);
  console.log("Markdown negotiation, robots.txt, the sitemap index and llms.txt passed.");
  const updated = (await call("update_post", { id: created.id, markdown: `${marker}\n\nEdited successfully.`, expected_version: created.version })).post;
  assert.equal(updated.version, 2);
  assert.equal(updated.created_at, created.created_at);
  const stale = await client.callTool({ name: "update_post", arguments: { id: created.id, markdown: "Stale change", expected_version: 1 } });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, "conflict");
  created = updated;
  page = await fetch(created.url);
  assert.match(await page.text(), /Edited successfully\./);
  assert.equal((await call("get_post", { id: created.id })).post.version, 2);
  assert.ok((await call("list_posts", {})).posts.some((post) => post.id === created.id));
  await call("delete_post", { id: created.id, expected_version: created.version });
  deleted = true;
  assert.equal((await fetch(created.url)).status, 404);
  assert.equal((await fetch(new URL("/mcp", created.url), { method: "POST" })).status, 405);
  console.log("Editing, conflict rejection, listing, reading, deletion and public-host isolation passed.");
} finally {
  // If creation succeeded but its response was lost, find this run's unique marker.
  if (connected && creationAttempted && !created) {
    let cursor;
    do {
      const page = await call("list_posts", cursor ? { cursor } : {});
      created = page.posts.find((post) => post.markdown.startsWith(marker));
      cursor = page.next_cursor;
    } while (!created && cursor);
  }
  if (created && !deleted) {
    const current = await client.callTool({ name: "get_post", arguments: { id: created.id } });
    const post = current.structuredContent?.post;
    if (post) await call("delete_post", { id: post.id, expected_version: post.version });
    console.log("Removed the temporary verification post.");
  }
  await client.close();
}
