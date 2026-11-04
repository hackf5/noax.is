import { env as runtimeEnv } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, type D1Migration } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { Posts } from "../src/posts";
import type { Env, Post } from "../src/types";

const env = runtimeEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const contexts: ExecutionContext[] = [];
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let token: string;

async function signedToken(options: { audience?: string; issuer?: string; expired?: boolean; wrongKey?: boolean } = {}) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("test-harness")
    .setIssuer(options.issuer ?? env.ACCESS_TEAM_DOMAIN)
    .setAudience(options.audience ?? env.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime(options.expired ? Math.floor(Date.now() / 1000) - 60 : "5m")
    .sign(options.wrongKey ? otherPrivateKey : privateKey);
}

async function request(url: string | URL, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  contexts.push(ctx);
  return worker.fetch(new Request(url, init), env, ctx);
}

async function withClient<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "noax-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.noax.is/mcp"), {
    requestInit: { headers: { "Cf-Access-Jwt-Assertion": token } },
    fetch: (url, init) => request(String(url), init),
  });
  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
  }
}

type ToolResult = Omit<CallToolResult, "structuredContent"> & { structuredContent?: Record<string, unknown> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return await client.callTool({ name, arguments: args }) as ToolResult;
}

function postFrom(result: ToolResult): Post & { url: string } {
  expect(result.isError).not.toBe(true);
  return result.structuredContent!.post as Post & { url: string };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  otherPrivateKey = (await generateKeyPair("RS256")).privateKey;
  const publicKey = { ...await exportJWK(pair.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [publicKey] });
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  token = await signedToken();
});

beforeEach(async () => { await env.DB.exec("DELETE FROM posts"); });
afterEach(async () => { await Promise.all(contexts.splice(0).map(waitOnExecutionContext)); });
afterAll(() => { vi.restoreAllMocks(); });

describe("MCP publishing", () => {
  it("discovers exactly five annotated tools through the real MCP protocol", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(["create_post", "delete_post", "get_post", "list_posts", "update_post"]);
      expect(tools.find((tool) => tool.name === "get_post")?.annotations?.readOnlyHint).toBe(true);
      expect(tools.find((tool) => tool.name === "delete_post")?.annotations?.destructiveHint).toBe(true);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema?.type).toBe("object");
      }
      expect((await call(client, "list_posts", {})).structuredContent).toEqual({ posts: [], next_cursor: null });
    });
  });

  it("publishes, reads, edits, rejects stale changes and deletes a post", async () => {
    await withClient(async (client) => {
      const created = postFrom(await call(client, "create_post", { markdown: "Hello **world**. It's a post." }));
      expect(created.version).toBe(1);
      expect(created.url).toBe(`https://noax.is/posts/${created.id}`);
      expect(await (await request(created.url)).text()).toContain("<strong>world</strong>");
      expect(postFrom(await call(client, "get_post", { id: created.id }))).toEqual(created);
      const updated = postFrom(await call(client, "update_post", { id: created.id, markdown: "Edited", expected_version: 1 }));
      expect(updated.version).toBe(2);
      expect(updated.created_at).toBe(created.created_at);
      expect(updated.id).toBe(created.id);
      expect(await (await request(created.url)).text()).toContain("Edited");
      const staleEdit = await call(client, "update_post", { id: created.id, markdown: "Stale", expected_version: 1 });
      expect(staleEdit.isError).toBe(true);
      expect(staleEdit.structuredContent!.error).toMatchObject({ code: "conflict" });
      const staleDelete = await call(client, "delete_post", { id: created.id, expected_version: 1 });
      expect(staleDelete.isError).toBe(true);
      expect(staleDelete.structuredContent!.error).toMatchObject({ code: "conflict" });
      expect(postFrom(await call(client, "get_post", { id: created.id })).markdown).toBe("Edited");
      expect((await call(client, "delete_post", { id: created.id, expected_version: 2 })).structuredContent).toEqual({ deleted: true, id: created.id });
      expect((await request(created.url)).status).toBe(404);
      const missing = await call(client, "get_post", { id: created.id });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent!.error).toMatchObject({ code: "not_found" });
    });
  });

  it("rejects empty or oversized Markdown and malformed inputs without inserting data", async () => {
    await withClient(async (client) => {
      for (const markdown of ["", " \n\t", "a".repeat(64_001)]) {
        expect((await call(client, "create_post", { markdown })).isError).toBe(true);
      }
      expect((await call(client, "get_post", { id: "not-an-id" })).isError).toBe(true);
      const cursor = await call(client, "list_posts", { cursor: "not-a-cursor" });
      expect(cursor.isError).toBe(true);
      expect(cursor.structuredContent!.error).toMatchObject({ code: "validation" });
      expect((await call(client, "list_posts", {})).structuredContent).toMatchObject({ posts: [] });
    });
  });

  it("supports legacy stateless Streamable HTTP clients", async () => {
    const response = await request("https://mcp.noax.is/mcp", {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": token,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-test", version: "1" },
      } }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("2025-11-25");
    expect(body).toContain("noax.is");
  });

  it("atomically rejects one of two simultaneous edits based on the same version", async () => {
    const posts = new Posts(env.DB);
    const created = await posts.create("Original");
    const edits = await Promise.allSettled([
      posts.update(created.id, "First edit", 1), posts.update(created.id, "Second edit", 1),
    ]);
    expect(edits.filter((edit) => edit.status === "fulfilled")).toHaveLength(1);
    expect(edits.filter((edit) => edit.status === "rejected")).toHaveLength(1);
    expect(edits.find((edit) => edit.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    expect((await posts.get(created.id)).version).toBe(2);
  });
});

describe("public reading", () => {
  it("serves an accessible empty page and stylesheet with no scripts or caching", async () => {
    const response = await request("https://noax.is/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(html).toContain('lang="en"');
    expect(html).toContain("<main>");
    expect(html).toContain("No posts yet.");
    expect(html).not.toContain("<script");
    const css = await request("https://noax.is/style.css");
    expect(css.headers.get("Content-Type")).toContain("text/css");
  });

  it("renders basic Markdown while escaping HTML and blocking unsafe links and images", async () => {
    const posts = new Posts(env.DB);
    const post = await posts.create("# Heading\n\n**bold** and *emphasis* with [link](https://example.com).\n\n- item\n\n> quote\n\n`inline`\n\n```js\nconst x = '<tag>';\n```\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n![photo](https://example.com/photo.png)");
    const html = await (await request(`https://noax.is/posts/${post.id}`)).text();
    for (const fragment of ["<h2>Heading</h2>", "<strong>bold</strong>", "<em>emphasis</em>", '<a href="https://example.com">', "<ul>", "<blockquote>", "<code>inline</code>", '<pre tabindex="0">', "&lt;script&gt;"]) expect(html).toContain(fragment);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<img");
    expect(html.match(/<h1>/g)).toHaveLength(1);
  });

  it("paginates deterministically, including posts sharing the same timestamp", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    await env.DB.batch(ids.map((id, index) => env.DB.prepare(
      "INSERT INTO posts (id, markdown, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(id, `Post ${index}`, "2026-11-04T12:00:00.000Z", "2026-11-04T12:00:00.000Z")));
    const posts = new Posts(env.DB);
    const first = await posts.list();
    expect(first.posts).toHaveLength(20);
    expect(first.posts.map((post) => post.id)).toEqual([...ids].reverse().slice(0, 20));
    const second = await posts.list(first.next_cursor!);
    expect(second.posts.map((post) => post.id)).toEqual([ids[0]]);
    expect(second.next_cursor).toBeNull();
    const firstHtml = await (await request("https://noax.is/")).text();
    expect(firstHtml).toContain("Older posts");
    const secondHtml = await (await request(`https://noax.is/?before=${encodeURIComponent(first.next_cursor!)}`)).text();
    expect(secondHtml).toContain("Post 0");
    expect(secondHtml).not.toContain("Older posts");
    expect((await request("https://noax.is/?before=malformed")).status).toBe(400);
  });

  it("implements HEAD, missing pages and method restrictions", async () => {
    const head = await request("https://noax.is/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await request("https://noax.is/posts/00000000-0000-4000-8000-000000000001")).status).toBe(404);
    expect((await request("https://noax.is/unknown")).status).toBe(404);
    const write = await request("https://noax.is/", { method: "POST" });
    expect(write.status).toBe(405);
    expect(write.headers.get("Allow")).toBe("GET, HEAD");
  });
});

describe("Access authentication and routing", () => {
  it.each(["missing", "forged", "expired", "wrong_audience", "wrong_issuer", "wrong_signature"])("rejects %s authentication", async (kind) => {
    const badToken = kind === "missing" ? undefined : kind === "forged" ? "not-a-jwt" : await signedToken({
      expired: kind === "expired", audience: kind === "wrong_audience" ? "another-app" : undefined,
      issuer: kind === "wrong_issuer" ? "https://another-team.cloudflareaccess.com" : undefined,
      wrongKey: kind === "wrong_signature",
    });
    const response = await request("https://mcp.noax.is/mcp", { method: "POST", headers: badToken ? { "Cf-Access-Jwt-Assertion": badToken } : {} });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it("rejects missing Access configuration even with a correctly signed token", async () => {
    const response = await worker.fetch(new Request("https://mcp.noax.is/mcp", { headers: { "Cf-Access-Jwt-Assertion": token } }), { ...env, ACCESS_AUD: "" }, createExecutionContext());
    expect(response.status).toBe(403);
  });

  it("rejects cross-origin MCP requests and MCP operations on every other hostname", async () => {
    expect((await request("https://mcp.noax.is/mcp", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, Origin: "https://other.example" } })).status).toBe(403);
    expect((await request("https://noax.is/mcp", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token } })).status).toBe(405);
    expect((await request("https://noax.is/mcp")).status).toBe(404);
    expect((await request("https://other.workers.dev/mcp", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token } })).status).toBe(404);
    expect((await request("https://mcp.noax.is/")).status).toBe(404);
  });
});
