import { env as runtimeEnv } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, type D1Migration } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import worker from "../src/index";
import { stylesheet, stylesheetVersion } from "../src/html";
import { Posts, SITEMAP_SIZE } from "../src/posts";
import { backfillSlugs, type SlugQuery } from "../src/slug-backfill";
import { RENDER_VERSION, renderMarkdown } from "../src/render";
import type { Env, Post, Rendered } from "../src/types";

const env = runtimeEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const publicOrigin = `https://${env.PUBLIC_HOST}`;
const mcpOrigin = `https://${env.MCP_HOST}`;
const mcpEndpoint = `${mcpOrigin}/mcp`;
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

const slugQuery: SlugQuery = async <Row>(sql: string, params: (string | number)[]) =>
  (await env.DB.prepare(sql).bind(...params).all<Row>()).results;

async function withClient<T>(callback: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "noax-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint), {
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
      const created = postFrom(await call(client, "create_post", { markdown: "# The Future Was Free\n\nHello **world**. It's a post." }));
      expect(created.version).toBe(1);
      expect(created.slug).toBe("the-future-was-free");
      expect(created.url).toBe(`${publicOrigin}/posts/the-future-was-free`);
      expect(await (await request(created.url)).text()).toContain("<strong>world</strong>");
      expect(postFrom(await call(client, "get_post", { id: created.id }))).toEqual(created);
      const updated = postFrom(await call(client, "update_post", { id: created.id, markdown: "# A New Title\n\nEdited", expected_version: 1 }));
      expect(updated.version).toBe(2);
      expect(updated.created_at).toBe(created.created_at);
      expect(updated.id).toBe(created.id);
      expect(updated.slug).toBe(created.slug);
      expect(updated.url).toBe(created.url);
      const updatedHtml = await (await request(created.url)).text();
      expect(updatedHtml).toContain("Edited");
      expect(updatedHtml).toContain(`<title>A New Title · ${env.SITE_TITLE}</title>`);
      const staleEdit = await call(client, "update_post", { id: created.id, markdown: "Stale", expected_version: 1 });
      expect(staleEdit.isError).toBe(true);
      expect(staleEdit.structuredContent!.error).toMatchObject({ code: "conflict" });
      const staleDelete = await call(client, "delete_post", { id: created.id, expected_version: 1 });
      expect(staleDelete.isError).toBe(true);
      expect(staleDelete.structuredContent!.error).toMatchObject({ code: "conflict" });
      expect(postFrom(await call(client, "get_post", { id: created.id }))).toEqual(updated);
      expect((await call(client, "list_posts", {})).structuredContent).toMatchObject({ posts: [updated] });
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
    const response = await request(mcpEndpoint, {
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
    expect(body).toContain(env.SITE_TITLE);
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
    const response = await request(`${publicOrigin}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(html).toContain('lang="en-GB"');
    expect(html).toContain(`<a href="/">${env.SITE_TITLE}</a>`);
    expect(html).toContain("<main>");
    expect(html).toContain("No posts yet.");
    expect(html).not.toContain("<script");
    const css = await request(`${publicOrigin}/style.css`);
    expect(css.headers.get("Content-Type")).toContain("text/css");
  });

  it("renders basic Markdown while escaping HTML and blocking unsafe links and images", async () => {
    const posts = new Posts(env.DB);
    const post = await posts.create("# Heading\n\n**bold** and *emphasis* with [link](https://example.com).\n\n- item\n\n> quote\n\n`inline`\n\n```js\nconst x = '<tag>';\n```\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n![photo](https://example.com/photo.png)");
    const html = await (await request(`${publicOrigin}/posts/${post.slug}`)).text();
    for (const fragment of ["<h2>Heading</h2>", "<strong>bold</strong>", "<em>emphasis</em>", '<a href="https://example.com">', "<ul>", "<blockquote>", "<code>inline</code>", '<pre tabindex="0">', "&lt;script&gt;"]) expect(html).toContain(fragment);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<img");
    expect(html.match(/<h1>/g)).toHaveLength(1);
  });

  it("serves a titled slug permalink, links its homepage heading and redirects the UUID", async () => {
    const post = await new Posts(env.DB).create("# The Future Was Free\n\nThe article.");
    const response = await request(`${publicOrigin}/posts/the-future-was-free`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<title>The Future Was Free · ${env.SITE_TITLE}</title>`);
    expect(html).toContain("<h2>The Future Was Free</h2>");
    const homepage = await (await request(`${publicOrigin}/`)).text();
    expect(homepage).toContain('<h2><a href="/posts/the-future-was-free">The Future Was Free</a></h2>');
    expect(homepage.match(/href="\/posts\/the-future-was-free"/g)).toHaveLength(2);
    expect(homepage).not.toContain(`/posts/${post.id}`);
    expect(homepage).toContain(`<title>${env.SITE_TITLE}</title>`);
    for (const method of ["GET", "HEAD"]) {
      const redirect = await request(`${publicOrigin}/posts/${post.id}`, { method });
      expect(redirect.status).toBe(301);
      expect(redirect.headers.get("Location")).toBe("/posts/the-future-was-free");
      expect(redirect.headers.get("Cache-Control")).toBe("no-store");
      expect(await redirect.text()).toBe("");
    }
    const head = await request(`${publicOrigin}/posts/the-future-was-free`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe(response.headers.get("Content-Type"));
    expect(await head.text()).toBe("");
  });

  it("extracts the first top-level H1 and preserves inline formatting without nesting links", async () => {
    const post = await new Posts(env.DB).create(
      '> # Quoted heading\n\n```md\n# Code heading\n```\n\n# Café *Rock* &amp; `roll` [isn\'t](https://example.com)\n\n# Another heading\n\n[Body link](https://example.org)',
    );
    expect(post.slug).toBe("cafe-rock-roll-isnt");
    const homepage = await (await request(`${publicOrigin}/`)).text();
    const title = '<h2><a href="/posts/cafe-rock-roll-isnt">Café <em>Rock</em> &amp; <code>roll</code> isn\'t</a></h2>';
    expect(homepage).toContain(title);
    expect(homepage).toContain("<h2>Another heading</h2>");
    expect(homepage).not.toContain('href="https://example.com"');
    expect(homepage).toContain('href="https://example.org"');
    const html = await (await request(`${publicOrigin}/posts/${post.slug}`)).text();
    expect(html).toContain(`<title>Café Rock &amp; roll isn&#39;t · ${env.SITE_TITLE}</title>`);
    expect(html).toContain('<a href="https://example.com">');
  });

  it("uses stable slug URLs in Markdown, feeds and discovery after a title edit", async () => {
    const posts = new Posts(env.DB);
    const post = await posts.create("# Original title\n\nThe article.");
    await posts.update(post.id, "# Revised title\n\nThe article.", post.version);
    const canonical = `${publicOrigin}/posts/original-title`;
    const source = await request(`${canonical}.md`);
    expect(source.status).toBe(200);
    expect(source.headers.get("Link")).toBe(`<${canonical}>; rel="canonical"`);
    expect(await source.text()).toContain(`url: "${canonical}"`);
    for (const method of ["GET", "HEAD"]) {
      const redirect = await request(`${publicOrigin}/posts/${post.id}.md`, { method });
      expect(redirect.status).toBe(301);
      expect(redirect.headers.get("Location")).toBe("/posts/original-title.md");
      expect(await redirect.text()).toBe("");
    }
    const [bucket] = await posts.sitemapBuckets();
    for (const path of ["/index.md", "/llms.txt", "/feed.xml", `/sitemap-posts-${bucket!.bucket}.xml`]) {
      const response = await request(`${publicOrigin}${path}`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(canonical);
      expect(body).not.toContain(`/posts/${post.id}`);
      expect(body).not.toContain("<!--post-title-->");
    }
    const html = await (await request(canonical)).text();
    expect(html).toContain(`<link rel="canonical" href="${canonical}">`);
    expect(html).toContain(`<title>Revised title · ${env.SITE_TITLE}</title>`);
  });

  it("links a cached title without rendering its Markdown again", async () => {
    const render = vi.fn(renderMarkdown);
    const posts = new Posts(env.DB, render);
    const post = await posts.create("# *Cached* title\n\nBody.");
    render.mockClear();
    await posts.getBySlug(post.slug!);
    await posts.listPublished();
    expect(render).not.toHaveBeenCalled();
    const html = await (await request(`${publicOrigin}/`)).text();
    expect(html).toContain('<h2><a href="/posts/cached-title"><em>Cached</em> title</a></h2>');
    expect(html).not.toContain("<!--post-title-->");
  });

  it("escapes heading text in page metadata", async () => {
    const post = await new Posts(env.DB).create('# <script> & "Quotes"');
    const html = await (await request(`${publicOrigin}/posts/${post.slug}`)).text();
    expect(html).toContain(`<title>&lt;script&gt; &amp; &quot;Quotes&quot; · ${env.SITE_TITLE}</title>`);
    expect(html).not.toContain("<script>");
  });

  it("supports posts without a title and titles that contain no slug characters", async () => {
    const posts = new Posts(env.DB);
    const untitled = await posts.create("A short note without a heading.");
    const symbols = await posts.create("# !!!");
    const emptyHeading = await posts.create("#");
    expect(untitled.slug).toBe("post");
    expect(symbols.slug).toBe("post-2");
    expect(emptyHeading.slug).toBe("post-3");
    const html = await (await request(`${publicOrigin}/posts/post`)).text();
    expect(html).toContain(`<title>Post · ${env.SITE_TITLE}</title>`);
    expect(html).toContain("A short note without a heading.");
    const homepage = await (await request(`${publicOrigin}/`)).text();
    expect(homepage).not.toContain('<h2><a href="/posts/post-3">');
  });

  it("allocates unique slugs for duplicate, normalised and concurrent titles", async () => {
    const posts = new Posts(env.DB);
    expect((await posts.create("# Café!")).slug).toBe("cafe");
    expect((await posts.create("# Cafe?")).slug).toBe("cafe-2");
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => posts.create("# Shared title")));
    expect(concurrent.map((post) => post.slug).sort()).toEqual([
      "shared-title", ...Array.from({ length: 11 }, (_, index) => `shared-title-${index + 2}`),
    ].sort());
    for (const post of concurrent) {
      expect((await request(`${publicOrigin}/posts/${post.slug}`)).status).toBe(200);
    }
  });

  async function insertSlugs(slugs: string[]) {
    if (slugs.length) await env.DB.batch(slugs.map((slug) => env.DB.prepare(
      "INSERT INTO posts (id, slug, markdown, created_at, updated_at) VALUES (?, ?, 'Post', ?, ?)",
    ).bind(crypto.randomUUID(), slug, "2026-11-04T12:00:00.000Z", "2026-11-04T12:00:00.000Z")));
  }

  it("publishes in one query however many posts share a title", async () => {
    await insertSlugs(["post", ...Array.from({ length: 59 }, (_, index) => `post-${index + 2}`)]);
    // Counts executions, as one prepared statement can run many times. Local D1 doesn't enforce the limit.
    let queries = 0;
    const counting = {
      prepare(sql: string) {
        const statement = env.DB.prepare(sql);
        return { bind: (...values: unknown[]) => ({ first: () => { queries += 1; return statement.bind(...values).first(); } }) };
      },
    } as unknown as D1Database;
    const post = await new Posts(counting).create("A note with no heading.");
    expect(post.slug).toBe("post-61");
    expect(queries).toBe(1);
  });

  it.each<[string, string[], string, string]>([
    ["a new title", [], "# Post", "post"],
    ["the first duplicate", ["post"], "# Post", "post-2"],
    ["a headingless post", ["post", "post-2"], "No heading.", "post-3"],
    ["slugs that only share a prefix", ["post", "post-mortem", "postal-notes"], "# Post", "post-2"],
    ["a free base with numbered duplicates", ["post-2"], "# Post", "post"],
    ["a deleted duplicate", ["post", "post-3"], "# Post", "post-4"],
    ["a base ending in digits", ["week-12", "week-12-2"], "# Week 12", "week-12-3"],
    ["a digit run too long to be a suffix", ["post", "post-99999999999999999999"], "# Post", "post-2"],
  ])("allocates a slug given %s", async (_name, existing, markdown, expected) => {
    await insertSlugs(existing);
    const post = await new Posts(env.DB).create(markdown);
    expect(post.slug).toBe(expected);
    expect((await request(`${publicOrigin}/posts/${post.slug}`)).status).toBe(200);
  });

  it("keeps UUID-shaped headings out of the legacy URL namespace", async () => {
    const title = "00000000-0000-4000-8000-000000000001";
    const post = await new Posts(env.DB).create(`# ${title}`);
    expect(post.slug).toBe(`post-${title}`);
    expect((await request(`${publicOrigin}/posts/${post.slug}`)).status).toBe(200);
    expect((await request(`${publicOrigin}/posts/${post.id}`)).headers.get("Location")).toBe(`/posts/${post.slug}`);
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
    const firstHtml = await (await request(`${publicOrigin}/`)).text();
    expect(firstHtml).toContain("Older posts");
    const secondHtml = await (await request(`${publicOrigin}/?before=${encodeURIComponent(first.next_cursor!)}`)).text();
    expect(secondHtml).toContain("Post 0");
    expect(secondHtml).not.toContain("Older posts");
    expect((await request(`${publicOrigin}/?before=malformed`)).status).toBe(400);
  });

  it("implements HEAD, missing pages and method restrictions", async () => {
    const head = await request(`${publicOrigin}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await request(`${publicOrigin}/posts/00000000-0000-4000-8000-000000000001`)).status).toBe(404);
    expect((await request(`${publicOrigin}/unknown`)).status).toBe(404);
    const write = await request(`${publicOrigin}/`, { method: "POST" });
    expect(write.status).toBe(405);
    expect(write.headers.get("Allow")).toBe("GET, HEAD");
  });
});

describe("render cache", () => {
  const timestamp = "2026-11-04T12:00:00.000Z";
  const stale = RENDER_VERSION - 1;
  const id = "00000000-0000-4000-8000-000000000001";
  const ids = [1, 2, 3, 4, 5].map((index) => `00000000-0000-4000-8000-00000000000${index}`);

  async function insertRow(rowId: string, markdown: string, html: string | null, renderVersion: number | null) {
    await env.DB.prepare(
      "INSERT INTO posts (id, markdown, html, title, summary, render_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(rowId, markdown, html, html && "Stored title", html && "Stored summary", renderVersion, timestamp, timestamp).run();
  }

  async function row(rowId: string) {
    return (await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(rowId).first<Post & Rendered & { render_version: number | null }>())!;
  }

  async function currentRows(): Promise<string[]> {
    const { results } = await env.DB.prepare("SELECT id FROM posts WHERE render_version = ? ORDER BY id").bind(RENDER_VERSION).all<{ id: string }>();
    return results.map((result) => result.id);
  }

  // Posts only calls prepare, so this lets a test act around the cache save.
  function aroundSave(around: (save: () => Promise<unknown>) => Promise<unknown>): D1Database {
    return {
      prepare(sql: string) {
        const statement = env.DB.prepare(sql);
        if (!sql.startsWith("UPDATE posts SET html")) return statement;
        return { bind: (...values: unknown[]) => ({ run: () => around(() => statement.bind(...values).run()) }) };
      },
    } as unknown as D1Database;
  }

  it("stores rendered HTML, escaped, with the current version, and refreshes it on edit", async () => {
    const posts = new Posts(env.DB);
    const post = await posts.create("# Title\n\n<script>alert(1)</script>");
    const stored = await row(post.id);
    expect(stored.render_version).toBe(RENDER_VERSION);
    expect(stored.html).toContain("<h2>Title</h2>");
    expect(stored.html).toContain("&lt;script&gt;");
    expect(stored.html).not.toContain("<script>");
    await posts.update(post.id, "# New title\n\nNew body.", 1);
    expect(await posts.getPublished(post.id)).toMatchObject({ title: "New title", summary: "New body." });
  });

  it("serves current output without calling the renderer", async () => {
    await insertRow(id, "**from markdown**", "<p>from stored html</p>", RENDER_VERSION);
    for (const url of [`${publicOrigin}/`, `${publicOrigin}/posts/${id}`]) {
      const html = await (await request(url)).text();
      expect(html).toContain("from stored html");
      expect(html).not.toContain("from markdown");
    }
    const render = vi.fn(renderMarkdown);
    const posts = new Posts(env.DB, render);
    await posts.listPublished();
    await posts.getPublished(id);
    expect(render).not.toHaveBeenCalled();
  });

  it("rebuilds output from another renderer version without touching the post's version or dates", async () => {
    await insertRow(id, "**new output**", "<p>old output</p>", stale);
    const html = await (await request(`${publicOrigin}/posts/${id}`)).text();
    expect(html).toContain("<strong>new output</strong>");
    expect(html).not.toContain("old output");
    expect(await row(id)).toMatchObject({
      html: "<p><strong>new output</strong></p>\n", title: "Post", render_version: RENDER_VERSION, version: 1, updated_at: timestamp,
    });
  });

  it("rebuilds after a rollback too, so any different version counts as stale", async () => {
    await insertRow(id, "**new output**", "<p>from a newer renderer</p>", RENDER_VERSION + 1);
    expect((await new Posts(env.DB).getPublished(id)).html).toContain("<strong>new output</strong>");
    expect((await row(id)).render_version).toBe(RENDER_VERSION);
  });

  it("rebuilds and saves rows from before the migration", async () => {
    await insertRow(id, "# Old post\n\nOld **body**.", null, null);
    const html = await (await request(`${publicOrigin}/posts/${id}`)).text();
    expect(html).toContain("<strong>body</strong>");
    expect(html).toContain("<title>Old post · Test Blog</title>");
    expect(await row(id)).toMatchObject({ title: "Old post", summary: "Old body.", render_version: RENDER_VERSION });
  });

  it.each(["/", "/feed.xml", `/posts/${id}`])("heals the cache when %s is read", async (path) => {
    await insertRow(id, "Fresh output", "<p>old output</p>", stale);
    const body = await (await request(`${publicOrigin}${path}`)).text();
    expect(body).toContain("Fresh output");
    expect(body).not.toContain("old output");
    expect((await row(id)).render_version).toBe(RENDER_VERSION);
  });

  it("keeps posts already rebuilt when a request dies partway through", async () => {
    for (const rowId of ids) await insertRow(rowId, `Post ${rowId}`, "<p>old output</p>", stale);
    let calls = 0;
    const dying = new Posts(env.DB, (markdown) => {
      calls += 1;
      if (calls === 4) throw new Error("Simulated CPU limit");
      return renderMarkdown(markdown);
    });
    await expect(dying.listPublished()).rejects.toThrow("Simulated CPU limit");
    // The page is newest first, which is highest id first here.
    expect(await currentRows()).toEqual(ids.slice(2));

    const render = vi.fn(renderMarkdown);
    const page = await new Posts(env.DB, render).listPublished();
    expect(render.mock.calls.map(([markdown]) => markdown)).toEqual([`Post ${ids[1]}`, `Post ${ids[0]}`]);
    expect(page.posts.map((post) => post.html).join("")).not.toContain("old output");
    expect(await currentRows()).toEqual(ids);

    render.mockClear();
    await new Posts(env.DB, render).listPublished();
    expect(render).not.toHaveBeenCalled();
  });

  it("finishes saving each post before rendering the next", async () => {
    for (const rowId of ids.slice(0, 3)) await insertRow(rowId, "Post", "<p>old output</p>", stale);
    const log: string[] = [];
    const posts = new Posts(aroundSave(async (save) => {
      const result = await save();
      log.push("saved");
      return result;
    }), (markdown) => {
      log.push("rendered");
      return renderMarkdown(markdown);
    });
    await posts.listPublished();
    expect(log).toEqual(["rendered", "saved", "rendered", "saved", "rendered", "saved"]);
  });

  it("doesn't overwrite an edit that lands during a rebuild", async () => {
    await insertRow(id, "Old text", "<p>old output</p>", stale);
    const posts = new Posts(aroundSave(async (save) => {
      await new Posts(env.DB).update(id, "Newer edit", 1);
      return save();
    }));
    await posts.getPublished(id);
    expect(await row(id)).toMatchObject({ markdown: "Newer edit", html: "<p>Newer edit</p>\n", title: "Post", version: 2 });
  });

  it("still serves the page if the cache can't be saved", async () => {
    await insertRow(id, "Fresh output", "<p>old output</p>", stale);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const posts = new Posts(aroundSave(async () => { throw new Error("D1 unavailable"); }));
    expect((await posts.getPublished(id)).html).toContain("Fresh output");
    expect(logged).toHaveBeenCalledWith("Render cache write failed", "Error");
    logged.mockRestore();
    expect((await row(id)).render_version).toBe(stale);
  });

  it("stores the current version when a stale post is edited through MCP", async () => {
    await insertRow(id, "Original", "<p>old output</p>", stale);
    await withClient(async (client) => {
      postFrom(await call(client, "update_post", { id, markdown: "Edited", expected_version: 1 }));
    });
    expect(await row(id)).toMatchObject({ html: "<p>Edited</p>\n", render_version: RENDER_VERSION });
  });

  it("keeps rendered columns out of MCP responses", async () => {
    await withClient(async (client) => {
      const created = postFrom(await call(client, "create_post", { markdown: "Shape check" }));
      const expected = ["created_at", "id", "markdown", "slug", "updated_at", "url", "version"];
      expect(Object.keys(created).sort()).toEqual(expected);
      expect(Object.keys(postFrom(await call(client, "get_post", { id: created.id }))).sort()).toEqual(expected);
      const { posts } = (await call(client, "list_posts", {})).structuredContent as { posts: Post[] };
      expect(Object.keys(posts[0]!).sort()).toEqual(expected);
    });
  });
});

describe("renderer output", () => {
  const sample = [
    "# Heading one", "", "## Heading two", "", "###### Heading six", "",
    'Text with **bold**, *emphasis*, `code` and a [link](https://example.com "Title").  ', "A hard break.", "",
    "> A quote", "", "- bullet", "", "1. number", "", "---", "",
    "```js", 'const x = "<tag>";', "```", "", "    indented", "",
    "<b>raw</b> and ![image](https://example.com/a.png) and [unsafe](javascript:alert(1))",
  ].join("\n");

  // One entry per RENDER_VERSION. If this fails because you changed the renderer, bump RENDER_VERSION
  // and add a new entry, so stored posts rebuild. Don't edit an existing entry.
  const expectedOutput: Record<number, Rendered> = {
    1: {
      html: [
        "<h2>Heading one</h2>", "<h3>Heading two</h3>", "<h6>Heading six</h6>",
        '<p>Text with <strong>bold</strong>, <em>emphasis</em>, <code>code</code> and a <a href="https://example.com" title="Title">link</a>.<br />',
        "A hard break.</p>", "<blockquote>", "<p>A quote</p>", "</blockquote>",
        "<ul>", "<li>bullet</li>", "</ul>", "<ol>", "<li>number</li>", "</ol>", "<hr />",
        '<pre tabindex="0"><code class="language-js">const x = &quot;&lt;tag&gt;&quot;;', "</code></pre>",
        '<pre tabindex="0"><code>indented', "</code></pre>",
        '<p>&lt;b&gt;raw&lt;/b&gt; and !<a href="https://example.com/a.png">image</a> and [unsafe](javascript:alert(1))</p>',
        "",
      ].join("\n"),
      title: "Heading one",
      summary: "Heading two Heading six Text with bold, emphasis, code and a link. A hard break. A quote bullet number <b>raw</b> and !image and [unsafe](javascript:alert(1))",
    },
  };
  expectedOutput[2] = { ...expectedOutput[1]!, html: `<!--post-title-->${expectedOutput[1]!.html}` };

  it("matches the recorded output for the current RENDER_VERSION", () => {
    expect(renderMarkdown(sample), "Rendered output changed: bump RENDER_VERSION in src/render.ts and add a new entry here.").toEqual(expectedOutput[RENDER_VERSION]);
  });
});

describe("post metadata", () => {
  async function pageFor(markdown: string): Promise<string> {
    const post = await new Posts(env.DB).create(markdown);
    return (await request(`${publicOrigin}/posts/${post.slug}`)).text();
  }

  it("titles a post from its heading and summarises the text after it", async () => {
    const html = await pageFor("# A *real* `title`\n\nThe first **paragraph**.\n\nThe second.");
    expect(html).toContain("<title>A real title · Test Blog</title>");
    expect(html).toContain('<meta name="description" content="The first paragraph. The second.">');
    expect(html).toContain('<meta property="og:title" content="A real title">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta property="og:site_name" content="Test Blog">');
    expect(html).toContain('<meta property="article:published_time"');
    expect(html).toContain(`<link rel="canonical" href="${publicOrigin}/posts/`);
  });

  it("uses the fallback title without an H1 and truncates the description", async () => {
    const line = "word ".repeat(60).trim();
    const html = await pageFor(`${line}\nA second line.`);
    const title = /<title>(.*) · Test Blog<\/title>/.exec(html)![1]!;
    expect(title).toBe("Post");
    const description = /<meta name="description" content="([^"]*)">/.exec(html)![1]!;
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it("handles posts with no inline text", async () => {
    expect(await pageFor("```\ncode only\n```")).toContain("<title>Post · Test Blog</title>");
  });

  it("escapes metadata taken from post text", async () => {
    const html = await pageFor('# "><script>alert(1)</script>\n\n"><img src=x onerror=alert(1)>');
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).not.toContain("<script");
    expect(head).not.toContain("<img");
    expect(head).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("gives the first timeline page a canonical URL and older pages none", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    await env.DB.batch(ids.map((id) => env.DB.prepare(
      "INSERT INTO posts (id, markdown, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(id, "Post", "2026-11-04T12:00:00.000Z", "2026-11-04T12:00:00.000Z")));
    const first = await (await request(`${publicOrigin}/`)).text();
    expect(first).toContain(`<link rel="canonical" href="${publicOrigin}/">`);
    expect(first).toContain('<link rel="alternate" type="application/atom+xml"');
    const cursor = (await new Posts(env.DB).list()).next_cursor!;
    expect(await (await request(`${publicOrigin}/?before=${cursor}`)).text()).not.toContain('rel="canonical"');
  });
});

describe("Atom feed", () => {
  it("is well-formed when empty", async () => {
    const response = await request(`${publicOrigin}/feed.xml`);
    expect(response.headers.get("Content-Type")).toBe("application/atom+xml; charset=utf-8");
    const xml = await response.text();
    expect(xml).toContain("<updated>1970-01-01T00:00:00.000Z</updated>");
    expect(xml).toContain("<title>Test Blog</title>");
    expect(xml).not.toContain("<entry>");
  });

  it("publishes absolute URLs and escaped content, newest first", async () => {
    const posts = new Posts(env.DB);
    const older = await posts.create("# Older");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await posts.create("# Newer & <better>\n\nBody with **bold** and a form\ffeed.");
    const xml = await (await request(`${publicOrigin}/feed.xml`)).text();
    expect(xml.indexOf(newer.id)).toBeLessThan(xml.indexOf(older.id));
    expect(xml).toContain(`<id>urn:uuid:${newer.id}</id>`);
    expect(xml).toContain(`href="${publicOrigin}/posts/${newer.slug}"`);
    expect(xml).toContain(`rel="self" type="application/atom+xml" href="${publicOrigin}/feed.xml"`);
    expect(xml).toContain("<title>Newer &amp; &lt;better&gt;</title>");
    expect(xml).toContain("&lt;strong&gt;bold&lt;/strong&gt;");
    expect(xml).not.toContain("<strong>");
    expect(xml).not.toContain("\f");
    expect(xml).toContain(`<updated>${newer.updated_at}</updated>`);
  });

  it("uses the newest edit as the feed's updated time", async () => {
    const posts = new Posts(env.DB);
    const post = await posts.create("Original");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const edited = await posts.update(post.id, "Edited", 1);
    const xml = await (await request(`${publicOrigin}/feed.xml`)).text();
    expect(xml.slice(0, xml.indexOf("<entry>"))).toContain(`<updated>${edited.updated_at}</updated>`);
  });

  it("supports HEAD and rejects writes", async () => {
    const head = await request(`${publicOrigin}/feed.xml`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await request(`${publicOrigin}/feed.xml`, { method: "POST" })).status).toBe(405);
  });
});

describe("Markdown pages", () => {
  const browser = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
  const claudeCode = "text/markdown, text/html, */*";
  const openCode = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
  const markdown = { headers: { Accept: "text/markdown" } };

  it.each([
    [browser, "text/html"],
    ["*/*", "text/html"],
    ["", "text/html"],
    [claudeCode, "text/markdown"],
    [openCode, "text/markdown"],
    ["application/json, text/plain, */*", "text/html"],
    ["text/plain", "text/plain"],
    ["text/plain, */*;q=0.5", "text/plain"],
    ["text/html;q=0.9, text/plain", "text/plain"],
    ["text/html, text/plain", "text/html"],
    ["text/html, text/markdown", "text/markdown"],
    ["text/html, text/markdown;q=0.9", "text/html"],
    ["text/markdown;q=0.5, */*;q=0.8", "text/html"],
    ["text/markdown;q=0.5, text/*;q=0.8", "text/html"],
    ["text/markdown;q=0, */*", "text/html"],
    ["TEXT/MarkDown ; Q=0.5", "text/markdown"],
    ["text/markdown;charset=utf-8;q=1", "text/markdown"],
    ["text/markdown;q=oops", "text/html"],
    ["text/markdown, text/html;q=oops", "text/html"],
  ])("answers Accept: %s with %s", async (accept, type) => {
    const post = await new Posts(env.DB).create("Hello");
    for (const path of ["/", `/posts/${post.slug}`]) {
      const response = await request(`${publicOrigin}${path}`, { headers: accept ? { Accept: accept } : {} });
      expect(response.headers.get("Content-Type")).toBe(`${type}; charset=utf-8`);
      expect(response.headers.get("Vary")).toBe("Accept");
    }
  });

  it("serves a post exactly as written beneath escaped front matter", async () => {
    const source = '# A "quoted" title\n\nThe **first** paragraph.\n\n[ref]: https://example.com';
    const post = await new Posts(env.DB).create(source);
    const url = `${publicOrigin}/posts/${post.slug}`;
    const response = await request(url, markdown);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Link")).toBe(`<${url}>; rel="canonical"`);
    expect(await response.text()).toBe([
      "---", 'title: "A \\"quoted\\" title"', 'description: "The first paragraph."', `url: "${url}"`,
      `published: "${post.created_at}"`, `updated: "${post.updated_at}"`, "---", "", source, "",
    ].join("\n"));
  });

  it("serves the same post at its .md URL, whatever Accept says", async () => {
    const post = await new Posts(env.DB).create("# Title\n\nBody");
    const expected = await (await request(`${publicOrigin}/posts/${post.slug}`, markdown)).text();
    for (const headers of [{ Accept: browser }, {}] as HeadersInit[]) {
      const response = await request(`${publicOrigin}/posts/${post.slug}.md`, { headers });
      expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
      expect(await response.text()).toBe(expected);
    }
  });

  it("never serves a post's source as HTML", async () => {
    const post = await new Posts(env.DB).create("<script>alert(1)</script>");
    for (const init of [markdown, { headers: { Accept: "text/plain" } }]) {
      for (const path of ["/", `/posts/${post.slug}`]) {
        const response = await request(`${publicOrigin}${path}`, init);
        expect(response.headers.get("Content-Type")).not.toContain("html");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
        expect(await response.text()).toContain("<script>alert(1)</script>");
      }
    }
  });

  it("points HTML pages at their Markdown versions", async () => {
    const post = await new Posts(env.DB).create("Hello");
    const home = await request(`${publicOrigin}/`);
    expect(home.headers.get("Link")).toBe('</index.md>; rel="alternate"; type="text/markdown"');
    expect(await home.text()).toContain('<link rel="alternate" type="text/markdown" href="/index.md">');
    const page = await request(`${publicOrigin}/posts/${post.slug}`);
    expect(page.headers.get("Link")).toBe(`</posts/${post.slug}.md>; rel="alternate"; type="text/markdown"`);
    expect(await page.text()).toContain(`<link rel="alternate" type="text/markdown" href="/posts/${post.slug}.md">`);
  });

  it("matches the timeline, with a permalink for each post and a guide for agents", async () => {
    const posts = new Posts(env.DB);
    const older = await posts.create("# Older\n\nOlder body.");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await posts.create("Newer body.");
    const response = await request(`${publicOrigin}/`, markdown);
    expect(response.headers.get("Link")).toBe(`<${publicOrigin}/>; rel="canonical"`);
    expect(await response.text()).toBe([
      "# Test Blog", "", "Notes for the test suite.", "", `Guide for agents: [llms.txt](${publicOrigin}/llms.txt)`, "", "---", "",
      `[${newer.created_at}](${publicOrigin}/posts/${newer.slug})`, "", "Newer body.", "", "---", "",
      `[${older.created_at}](${publicOrigin}/posts/${older.slug})`, "", "# Older", "", "Older body.", "",
    ].join("\n"));
    expect(await (await request(`${publicOrigin}/index.md`)).text()).toContain("Newer body.");
  });

  it("says so when there are no posts", async () => {
    const text = await (await request(`${publicOrigin}/index.md`)).text();
    expect(text).toContain("# Test Blog");
    expect(text).toContain("No posts yet.");
  });

  it("paginates like the HTML timeline", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    await env.DB.batch(ids.map((id, index) => env.DB.prepare(
      "INSERT INTO posts (id, markdown, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(id, `Post ${index}.`, "2026-11-04T12:00:00.000Z", "2026-11-04T12:00:00.000Z")));
    const first = await (await request(`${publicOrigin}/`, markdown)).text();
    const older = /\[Older posts\]\((.*)\)/.exec(first)![1]!;
    expect(older).toContain("/index.md?before=");
    expect(first).not.toContain("Post 0.");
    const response = await request(older);
    const before = new URL(older).search;
    expect(response.headers.get("Link")).toBe(`<${publicOrigin}/${before}>; rel="canonical"`);
    const second = await response.text();
    expect(second).toContain("Post 0.");
    expect(second).not.toContain("Older posts");
    expect((await request(`${publicOrigin}/${before}`)).headers.get("Link")).toBe(`</index.md${before}>; rel="alternate"; type="text/markdown"`);
  });

  it("reports errors in Markdown with the right status", async () => {
    const cases: [string, number, string][] = [
      ["/posts/00000000-0000-4000-8000-000000000001", 404, "# Not found"],
      ["/posts/00000000-0000-4000-8000-000000000001.md", 404, "# Not found"],
      ["/unknown", 404, "# Not found"],
      ["/?before=malformed", 400, "# Invalid pagination cursor"],
      ["/index.md?before=malformed", 400, "# Invalid pagination cursor"],
    ];
    for (const [path, status, heading] of cases) {
      const response = await request(`${publicOrigin}${path}`, markdown);
      expect(response.status).toBe(status);
      expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
      expect(response.headers.get("Vary")).toBe("Accept");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toContain(heading);
    }
    const html = await request(`${publicOrigin}/unknown`);
    expect(html.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("Vary")).toBe("Accept");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...env, DB: { prepare() { throw new Error("D1 unavailable"); } } } as unknown as Env;
    const failed = await worker.fetch(new Request(`${publicOrigin}/`, markdown), broken, createExecutionContext());
    expect(failed.status).toBe(500);
    expect(failed.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    logged.mockRestore();
  });

  it("supports HEAD, and leaves other paths alone", async () => {
    const post = await new Posts(env.DB).create("Hello");
    const head = await request(`${publicOrigin}/posts/${post.slug}.md`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await head.text()).toBe("");
    expect((await request(`${publicOrigin}/posts/${post.slug}.md`, { method: "POST" })).status).toBe(405);
    expect((await request(`${publicOrigin}/feed.xml`, markdown)).headers.get("Content-Type")).toBe("application/atom+xml; charset=utf-8");
    expect((await request(`${publicOrigin}/style.css`, markdown)).headers.get("Content-Type")).toContain("text/css");
    expect((await request(`${publicOrigin}/feed.xml.md`)).status).toBe(404);
  });
});

describe("agent discovery", () => {
  const timestamp = "2026-11-04T12:00:00.000Z";

  async function insertAt(rowid: number, updatedAt = timestamp): Promise<string> {
    const id = `00000000-0000-4000-8000-${String(rowid).padStart(12, "0")}`;
    await env.DB.prepare("INSERT INTO posts (rowid, id, markdown, created_at, updated_at) VALUES (?, ?, 'Post', ?, ?)").bind(rowid, id, timestamp, updatedAt).run();
    return id;
  }

  async function renderedRows(): Promise<number> {
    return (await env.DB.prepare("SELECT COUNT(*) AS rows FROM posts WHERE render_version IS NOT NULL").first<{ rows: number }>())!.rows;
  }

  const locations = (xml: string) => [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]!);

  it("publishes robots.txt with the configured signal and an absolute sitemap", async () => {
    const response = await request(`${publicOrigin}/robots.txt`);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(await response.text()).toBe(`User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nAllow: /\n\nSitemap: ${publicOrigin}/sitemap.xml\n`);
  });

  it("guides agents from llms.txt to the newest posts", async () => {
    const post = await new Posts(env.DB).create("# First post\n\nA summary.");
    const response = await request(`${publicOrigin}/llms.txt`);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    const text = await response.text();
    expect(text.startsWith("# Test Blog\n\n> Notes for the test suite.\n\n")).toBe(true);
    expect(text).toContain("`Accept: text/markdown`");
    expect(text).toContain(`## Recent posts\n\n- [First post](${publicOrigin}/posts/${post.slug}.md): A summary.\n`);
    expect(text).toContain(`## Optional\n\n- [Atom feed](${publicOrigin}/feed.xml)`);
    expect(text).toContain(`- [Sitemap](${publicOrigin}/sitemap.xml)`);
  });

  it("leaves out the posts section when there are none", async () => {
    const text = await (await request(`${publicOrigin}/llms.txt`)).text();
    expect(text).not.toContain("## Recent posts");
    expect(text).toContain("## Optional");
  });

  it("keeps links in post text inert in llms.txt", async () => {
    await new Posts(env.DB).create("# [x](javascript:alert(1)) <b>\n\n[y](javascript:alert(2)) back\\slash");
    const text = await (await request(`${publicOrigin}/llms.txt`)).text();
    expect(text).toContain("- [\\[x\\](javascript:alert(1)) \\<b>](");
    expect(text).toContain(": \\[y\\](javascript:alert(2)) back\\\\slash\n");
  });

  it("lists only the pages sitemap on an empty site", async () => {
    const index = await request(`${publicOrigin}/sitemap.xml`);
    expect(index.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(index.headers.get("Cache-Control")).toBe("public, max-age=300");
    const xml = await index.text();
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(locations(xml)).toEqual([`${publicOrigin}/sitemap-pages.xml`]);
    const pages = await (await request(`${publicOrigin}/sitemap-pages.xml`)).text();
    expect(pages).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(locations(pages)).toEqual([`${publicOrigin}/`]);
  });

  it("splits posts into fixed buckets of rowids, with their newest edit as lastmod", async () => {
    const newest = "2026-11-05T09:00:00.000Z";
    const [first, last, second, third] = [await insertAt(1), await insertAt(999, newest), await insertAt(1000), await insertAt(2500)];
    const index = await (await request(`${publicOrigin}/sitemap.xml`)).text();
    expect(locations(index)).toEqual([`${publicOrigin}/sitemap-pages.xml`, ...[0, 1, 2].map((bucket) => `${publicOrigin}/sitemap-posts-${bucket}.xml`)]);
    expect(index).toContain(`<loc>${publicOrigin}/sitemap-posts-0.xml</loc><lastmod>${newest}</lastmod>`);
    const posts = async (bucket: number) => request(`${publicOrigin}/sitemap-posts-${bucket}.xml`);
    const bucket0 = await (await posts(0)).text();
    expect(locations(bucket0)).toEqual([first, last].map((id) => `${publicOrigin}/posts/${id}`));
    expect(bucket0).toContain(`<loc>${publicOrigin}/posts/${last}</loc><lastmod>${newest}</lastmod>`);
    expect(locations(await (await posts(1)).text())).toEqual([`${publicOrigin}/posts/${second}`]);
    expect(locations(await (await posts(2)).text())).toEqual([`${publicOrigin}/posts/${third}`]);
    expect((await posts(1)).headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("never holds more than SITEMAP_SIZE posts in one file", async () => {
    await env.DB.batch(Array.from({ length: SITEMAP_SIZE + 5 }, (_, index) => env.DB.prepare(
      "INSERT INTO posts (id, markdown, created_at, updated_at) VALUES (?, 'Post', ?, ?)",
    ).bind(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, timestamp, timestamp)));
    const counts = await Promise.all([0, 1].map(async (bucket) =>
      locations(await (await request(`${publicOrigin}/sitemap-posts-${bucket}.xml`)).text()).length));
    expect(counts).toEqual([SITEMAP_SIZE - 1, 6]);
  });

  it("drops an emptied bucket without moving the others", async () => {
    await insertAt(1);
    const moved = await insertAt(1500);
    const gone = await insertAt(2500);
    const before = await (await request(`${publicOrigin}/sitemap-posts-1.xml`)).text();
    await new Posts(env.DB).delete(gone, 1);
    expect(await (await request(`${publicOrigin}/sitemap-posts-1.xml`)).text()).toBe(before);
    expect(before).toContain(moved);
    expect(locations(await (await request(`${publicOrigin}/sitemap.xml`)).text())).not.toContain(`${publicOrigin}/sitemap-posts-2.xml`);
    expect((await request(`${publicOrigin}/sitemap-posts-2.xml`)).status).toBe(404);
  });

  it("rejects buckets that aren't there or aren't spelled canonically", async () => {
    await insertAt(1);
    for (const path of ["/sitemap-posts-5.xml", "/sitemap-posts-01.xml", "/sitemap-posts--1.xml", "/sitemap-posts-1e3.xml", "/sitemap-posts-9999999999.xml", "/sitemaps/0.xml"]) {
      expect((await request(`${publicOrigin}${path}`)).status).toBe(404);
    }
  });

  it("lists canonical URLs only", async () => {
    await insertAt(1);
    const xml = await (await request(`${publicOrigin}/sitemap-posts-0.xml`)).text();
    expect(xml).not.toContain(".md");
    expect(xml).not.toContain("?before");
  });

  it.each(["/sitemap.xml", "/sitemap-posts-0.xml"])("doesn't render anything for %s", async (path) => {
    await insertAt(1);
    expect((await request(`${publicOrigin}${path}`)).status).toBe(200);
    expect(await renderedRows()).toBe(0);
  });

  it("doesn't render anything for the Markdown timeline", async () => {
    await insertAt(1);
    const response = await request(`${publicOrigin}/index.md`);
    expect(await response.text()).toContain("Post");
    expect(await renderedRows()).toBe(0);
  });

  it("supports HEAD and keeps every discovery path off the MCP host", async () => {
    for (const path of ["/robots.txt", "/llms.txt", "/sitemap.xml", "/sitemap-pages.xml"]) {
      const head = await request(`${publicOrigin}${path}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect((await request(`${publicOrigin}${path}`, { method: "POST" })).status).toBe(405);
      expect((await request(`${mcpOrigin}${path}`)).status).toBe(404);
    }
    expect((await request(`${mcpOrigin}/index.md`)).status).toBe(404);
  });
});

describe("Content Security Policy", () => {
  const restrictions = ["default-src 'none'", "style-src 'self'", "img-src 'self'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'"];
  const policy = (response: Response) => response.headers.get("Content-Security-Policy") ?? "";
  const nonceIn = (response: Response) => /script-src 'self' 'nonce-([A-Za-z0-9+/]+={0,2})'/.exec(policy(response))?.[1];

  it("gives each HTML response its own nonce of at least 16 random bytes", async () => {
    const post = await new Posts(env.DB).create("# Hello");
    for (const path of ["/", `/posts/${post.slug}`, "/nope", "/?before=malformed"]) {
      const nonces = await Promise.all(Array.from({ length: 5 }, async () => nonceIn(await request(`${publicOrigin}${path}`))));
      expect(new Set(nonces).size).toBe(5);
      for (const nonce of nonces) expect(atob(nonce!).length).toBeGreaterThanOrEqual(16);
    }
  });

  it("adds it to the header for HEAD and server errors too, as Cloudflare reads it there", async () => {
    expect(nonceIn(await request(`${publicOrigin}/`, { method: "HEAD" }))).toBeDefined();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...env, DB: { prepare() { throw new Error("D1 unavailable"); } } } as unknown as Env;
    const failed = await worker.fetch(new Request(`${publicOrigin}/`), broken, createExecutionContext());
    logged.mockRestore();
    expect(failed.status).toBe(500);
    expect(nonceIn(failed)).toBeDefined();
  });

  it("keeps every existing restriction and allows nothing looser for scripts", async () => {
    const value = policy(await request(`${publicOrigin}/`));
    for (const directive of restrictions) expect(value).toContain(directive);
    for (const loose of ["unsafe-inline", "unsafe-eval", "strict-dynamic", "script-src-elem", "*", "http:", "https:"]) expect(value).not.toContain(loose);
    expect(value.match(/script-src/g)).toHaveLength(1);
    expect(value).toContain("connect-src 'self'");
  });

  it("uses the header alone, with nothing in the HTML for a nonce to cover", async () => {
    const html = await (await request(`${publicOrigin}/`)).text();
    expect(html).not.toContain("http-equiv");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("nonce");
  });

  it("gives non-HTML responses no script permission at all", async () => {
    const post = await new Posts(env.DB).create("# Hello");
    const markdown = { headers: { Accept: "text/markdown" } };
    for (const [path, init] of [
      ["/style.css"], ["/favicon.svg"], ["/feed.xml"], ["/robots.txt"], ["/llms.txt"], ["/sitemap.xml"], ["/sitemap-pages.xml"],
      ["/index.md"], [`/posts/${post.slug}.md`], ["/", markdown], [`/posts/${post.slug}`, markdown], ["/nope", markdown],
    ] as [string, RequestInit?][]) {
      const value = policy(await request(`${publicOrigin}${path}`, init));
      expect(value).toContain("default-src 'none'");
      expect(value).not.toContain("script-src");
      expect(value).not.toContain("connect-src");
      expect(value).not.toContain("nonce");
    }
  });

  it("never lets a nonce be reused from a cache", async () => {
    const post = await new Posts(env.DB).create("# Hello");
    for (const path of ["/", `/posts/${post.slug}`, "/nope"]) {
      const response = await request(`${publicOrigin}${path}`);
      expect(nonceIn(response)).toBeDefined();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.has("ETag")).toBe(false);
    }
  });
});

describe("cache headers", () => {
  const day = "public, max-age=86400";
  const shortly = "public, max-age=300";

  // Workers Cache sits in front of the Worker and follows these headers, so this table decides what
  // skips the Worker. Making a route cacheable should be a decision, not a side effect.
  it("pins what may be served without running the Worker", async () => {
    const post = await new Posts(env.DB).create("# Fresh");
    const markdown = { headers: { Accept: "text/markdown" } };
    const cases: [string, string, RequestInit?][] = [
      ["/favicon.svg", day], ["/favicon.ico", day], ["/robots.txt", day],
      ["/feed.xml", shortly], ["/llms.txt", shortly], ["/sitemap.xml", shortly], ["/sitemap-pages.xml", shortly], ["/sitemap-posts-0.xml", shortly],
      ["/", "no-store"], [`/posts/${post.slug}`, "no-store"], [`/posts/${post.id}`, "no-store"],
      ["/index.md", "no-store"], [`/posts/${post.slug}.md`, "no-store"], ["/", "no-store", markdown], [`/posts/${post.slug}`, "no-store", markdown],
      ["/unknown", "no-store"], ["/?before=malformed", "no-store"], ["/sitemap-posts-9.xml", "no-store"],
    ];
    for (const [path, expected, init] of cases) {
      expect((await request(`${publicOrigin}${path}`, init)).headers.get("Cache-Control"), path).toBe(expected);
    }
    expect((await request(`${publicOrigin}/`, { method: "POST" })).headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps the MCP host and /mcp out of the cache, as its key ignores hostnames", async () => {
    for (const path of ["/", "/feed.xml", "/style.css", "/robots.txt", "/llms.txt", "/sitemap.xml", "/unknown"]) {
      const response = await request(`${mcpOrigin}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("Cache-Control"), path).toBe("no-store");
    }
    const cases: [string, RequestInit?][] = [
      [mcpEndpoint], [mcpEndpoint, { headers: { "Cf-Access-Jwt-Assertion": token } }], [`${publicOrigin}/mcp`], [`${publicOrigin}/mcp`, { method: "POST" }],
    ];
    for (const [url, init] of cases) expect((await request(url, init)).headers.get("Cache-Control"), url).toBe("no-store");
  });
});

describe("stylesheet versioning", () => {
  const forever = "public, max-age=31536000, immutable";
  const shortly = "public, max-age=300";

  it("links every page to the version of the stylesheet it was built with", async () => {
    expect(stylesheetVersion).toBe(createHash("sha256").update(stylesheet).digest("hex").slice(0, 12));
    const post = await new Posts(env.DB).create("# Hello");
    for (const path of ["/", `/posts/${post.slug}`, "/nope"]) {
      expect(await (await request(`${publicOrigin}${path}`)).text()).toContain(`<link rel="stylesheet" href="/style.css?v=${stylesheetVersion}">`);
    }
  });

  it("lets browsers keep the current version for good", async () => {
    const response = await request(`${publicOrigin}/style.css?v=${stylesheetVersion}`);
    expect(response.headers.get("Cache-Control")).toBe(forever);
    expect(response.headers.get("Content-Type")).toContain("text/css");
    expect(await response.text()).toBe(stylesheet);
  });

  // During a deploy, a new page's request can reach an old isolate, which mustn't pin its old CSS to
  // the new URL for a year.
  it.each(["", "?v=", "?v=000000000000", `?v=${stylesheetVersion}x`])("only briefly caches /style.css%s", async (query) => {
    const response = await request(`${publicOrigin}/style.css${query}`);
    expect(response.headers.get("Cache-Control")).toBe(shortly);
    expect(await response.text()).toBe(stylesheet);
  });
});

describe("Access authentication and routing", () => {
  it.each(["missing", "forged", "expired", "wrong_audience", "wrong_issuer", "wrong_signature"])("rejects %s authentication", async (kind) => {
    const badToken = kind === "missing" ? undefined : kind === "forged" ? "not-a-jwt" : await signedToken({
      expired: kind === "expired", audience: kind === "wrong_audience" ? "another-app" : undefined,
      issuer: kind === "wrong_issuer" ? "https://another-team.cloudflareaccess.com" : undefined,
      wrongKey: kind === "wrong_signature",
    });
    const response = await request(mcpEndpoint, { method: "POST", headers: badToken ? { "Cf-Access-Jwt-Assertion": badToken } : {} });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it("rejects missing Access configuration even with a correctly signed token", async () => {
    const response = await worker.fetch(new Request(mcpEndpoint, { headers: { "Cf-Access-Jwt-Assertion": token } }), { ...env, ACCESS_AUD: "" }, createExecutionContext());
    expect(response.status).toBe(403);
  });

  it("rejects cross-origin MCP requests and MCP operations on every other hostname", async () => {
    expect((await request(mcpEndpoint, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, Origin: "https://other.example" } })).status).toBe(403);
    expect((await request(`${publicOrigin}/mcp`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token } })).status).toBe(405);
    expect((await request(`${publicOrigin}/mcp`)).status).toBe(404);
    expect((await request("https://other.workers.dev/mcp", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token } })).status).toBe(404);
    expect((await request(`${mcpOrigin}/`)).status).toBe(404);
  });
});
