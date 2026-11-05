import { env as runtimeEnv } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, type D1Migration } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { Posts } from "../src/posts";
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
      const created = postFrom(await call(client, "create_post", { markdown: "Hello **world**. It's a post." }));
      expect(created.version).toBe(1);
      expect(created.url).toBe(`${publicOrigin}/posts/${created.id}`);
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
    const html = await (await request(`${publicOrigin}/posts/${post.id}`)).text();
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
      html: "<p><strong>new output</strong></p>\n", title: "new output", render_version: RENDER_VERSION, version: 1, updated_at: timestamp,
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
    expect(await row(id)).toMatchObject({ markdown: "Newer edit", html: "<p>Newer edit</p>\n", title: "Newer edit", version: 2 });
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
      const expected = ["created_at", "id", "markdown", "updated_at", "url", "version"];
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

  it("matches the recorded output for the current RENDER_VERSION", () => {
    expect(renderMarkdown(sample), "Rendered output changed: bump RENDER_VERSION in src/render.ts and add a new entry here.").toEqual(expectedOutput[RENDER_VERSION]);
  });
});

describe("post metadata", () => {
  async function pageFor(markdown: string): Promise<string> {
    const post = await new Posts(env.DB).create(markdown);
    return (await request(`${publicOrigin}/posts/${post.id}`)).text();
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

  it("falls back to the first line and truncates long text at a word", async () => {
    const line = "word ".repeat(60).trim();
    const html = await pageFor(`${line}\nA second line.`);
    const title = /<title>(.*) · Test Blog<\/title>/.exec(html)![1]!;
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title.endsWith("word…")).toBe(true);
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
    expect(xml).toContain(`href="${publicOrigin}/posts/${newer.id}"`);
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

describe("cache headers", () => {
  it("caches assets and the feed but never pages or errors", async () => {
    for (const path of ["/style.css", "/favicon.svg", "/favicon.ico"]) {
      expect((await request(`${publicOrigin}${path}`)).headers.get("Cache-Control")).toBe("public, max-age=86400");
    }
    expect((await request(`${publicOrigin}/feed.xml`)).headers.get("Cache-Control")).toBe("public, max-age=300");
    const post = await new Posts(env.DB).create("Fresh");
    for (const path of ["/", `/posts/${post.id}`, "/unknown", "/?before=malformed"]) {
      expect((await request(`${publicOrigin}${path}`)).headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await request(`${publicOrigin}/`, { method: "POST" })).headers.get("Cache-Control")).toBe("no-store");
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
