import { authenticate } from "./auth";
import faviconIco from "./assets/favicon.ico";
import faviconSvg from "./assets/favicon.svg";
import { llmsTxt, pagesSitemap, postsSitemap, robotsTxt, sitemapIndex } from "./discovery";
import { atomFeed } from "./feed";
import { errorPage, postPage, siteFrom, stylesheet, timeline } from "./html";
import { markdownError, markdownPost, markdownTimeline, preferredText, type TextType } from "./markdown";
import { handleMcp } from "./mcp";
import { postPath, UUID_PATTERN } from "./post-metadata";
import { Posts } from "./posts";
import { PostError, type Env } from "./types";

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

// Pages stay uncached so edits and deletions appear on the next request.
const CACHE_ASSET = "public, max-age=86400";
const CACHE_FEED = "public, max-age=300";

const TYPE_TEXT = "text/plain; charset=utf-8";
const TYPE_XML = "application/xml; charset=utf-8";

const POST_PATH = /^\/posts\/([a-z0-9]+(?:-[a-z0-9]+)*)(\.md)?$/;
const SITEMAP_POSTS_PATH = /^\/sitemap-posts-(0|[1-9]\d{0,8})\.xml$/;

function respond(body: BodyInit | null, status = 200, type = "text/html; charset=utf-8", cache = "no-store"): Response {
  return new Response(body, { status, headers: { ...securityHeaders, "Cache-Control": cache, "Content-Type": type } });
}

// Every page exists as HTML and Markdown, so both say they depend on Accept.
function htmlPage(body: string, status = 200, markdownPath?: string): Response {
  const response = respond(body, status);
  response.headers.set("Vary", "Accept");
  if (markdownPath) response.headers.set("Link", `<${markdownPath}>; rel="alternate"; type="text/markdown"`);
  return response;
}

// respond() defaults to HTML, which would serve a post's raw source as markup, so the type is required.
function markdownPage(body: string, type: TextType, status = 200, canonical?: string): Response {
  const response = respond(body, status, `${type}; charset=utf-8`);
  response.headers.set("Vary", "Accept");
  if (canonical) response.headers.set("Link", `<${canonical}>; rel="canonical"`);
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === env.MCP_HOST) {
      if (url.pathname !== "/mcp") return respond("Not found", 404, "text/plain; charset=utf-8");
      if (!(await authenticate(request, env))) return respond("Forbidden", 403, "text/plain; charset=utf-8");
      if (request.headers.has("Origin") && request.headers.get("Origin") !== `https://${env.MCP_HOST}`) {
        return respond("Forbidden origin", 403, "text/plain; charset=utf-8");
      }
      const response = await handleMcp(request, env, ctx);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    if (url.hostname !== env.PUBLIC_HOST) return respond("Not found", 404, "text/plain; charset=utf-8");
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { ...securityHeaders, "Cache-Control": "no-store", Allow: "GET, HEAD" } });
    }
    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      const svg = url.pathname === "/favicon.svg";
      return respond(request.method === "HEAD" ? null : svg ? faviconSvg : faviconIco, 200,
        svg ? "image/svg+xml" : "image/vnd.microsoft.icon", CACHE_ASSET);
    }
    const site = siteFrom(env);
    const text = url.pathname.endsWith(".md") ? "text/markdown" : preferredText(request.headers.get("Accept"));
    const failure = (message: string, status: number) =>
      text ? markdownPage(markdownError(site, message), text, status) : htmlPage(errorPage(site, message), status);
    let response: Response;
    try {
      const posts = new Posts(env.DB);
      if (url.pathname === "/style.css") response = respond(stylesheet, 200, "text/css; charset=utf-8", CACHE_ASSET);
      else if (url.pathname === "/feed.xml") {
        response = respond(atomFeed(site, (await posts.listPublished()).posts), 200, "application/atom+xml; charset=utf-8", CACHE_FEED);
      } else if (url.pathname === "/robots.txt") {
        response = respond(robotsTxt(site), 200, TYPE_TEXT, CACHE_ASSET);
      } else if (url.pathname === "/llms.txt") {
        response = respond(llmsTxt(site, (await posts.listPublished()).posts), 200, TYPE_TEXT, CACHE_FEED);
      } else if (url.pathname === "/sitemap.xml") {
        response = respond(sitemapIndex(site, await posts.sitemapBuckets()), 200, TYPE_XML, CACHE_FEED);
      } else if (url.pathname === "/sitemap-pages.xml") {
        response = respond(pagesSitemap(site), 200, TYPE_XML, CACHE_FEED);
      } else if (url.pathname === "/" || url.pathname === "/index.md") {
        const before = url.searchParams.get("before") ?? undefined;
        const query = before ? `?before=${encodeURIComponent(before)}` : "";
        // Markdown pages read the source, so they never render, even with a stale cache.
        response = text
          ? markdownPage(markdownTimeline(site, await posts.list(before)), text, 200, `${site.origin}/${query}`)
          : htmlPage(timeline(site, await posts.listPublished(before), !before, `/index.md${query}`), 200, `/index.md${query}`);
      } else {
        const sitemap = SITEMAP_POSTS_PATH.exec(url.pathname);
        const post = POST_PATH.exec(url.pathname);
        if (sitemap) {
          const rows = await posts.sitemapPosts(Number(sitemap[1]));
          response = rows.length ? respond(postsSitemap(site, rows), 200, TYPE_XML, CACHE_FEED) : failure("Not found", 404);
        } else if (post) {
          const key = post[1]!;
          const found = await (UUID_PATTERN.test(key) ? posts.getPublished(key) : posts.getBySlug(key));
          const canonical = postPath(found);
          const path = `${canonical}${post[2] ?? ""}`;
          response = url.pathname !== path
            ? new Response(null, { status: 301, headers: { ...securityHeaders, "Cache-Control": "no-store", Location: path } })
            : text
              ? markdownPage(markdownPost(site, found), text, 200, `${site.origin}${canonical}`)
              : htmlPage(postPage(site, found), 200, `${canonical}.md`);
        } else {
          response = failure("Not found", 404);
        }
      }
    } catch (error) {
      if (error instanceof PostError) {
        response = error.code === "not_found" ? failure("Not found", 404) : failure("Invalid pagination cursor", 400);
      } else {
        console.error("Public request failed", error instanceof Error ? error.name : "unknown");
        response = failure("Unable to load posts", 500);
      }
    }
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
  },
} satisfies ExportedHandler<Env>;
