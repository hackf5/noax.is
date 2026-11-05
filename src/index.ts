import { authenticate } from "./auth";
import faviconIco from "./assets/favicon.ico";
import faviconSvg from "./assets/favicon.svg";
import { atomFeed } from "./feed";
import { errorPage, postPage, siteFrom, stylesheet, timeline } from "./html";
import { handleMcp } from "./mcp";
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

function respond(body: BodyInit | null, status = 200, type = "text/html; charset=utf-8", cache = "no-store"): Response {
  return new Response(body, { status, headers: { ...securityHeaders, "Cache-Control": cache, "Content-Type": type } });
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
    let response: Response;
    try {
      const posts = new Posts(env.DB);
      if (url.pathname === "/style.css") response = respond(stylesheet, 200, "text/css; charset=utf-8", CACHE_ASSET);
      else if (url.pathname === "/feed.xml") {
        response = respond(atomFeed(site, (await posts.listPublished()).posts), 200, "application/atom+xml; charset=utf-8", CACHE_FEED);
      } else if (url.pathname === "/") {
        const before = url.searchParams.get("before") ?? undefined;
        response = respond(timeline(site, await posts.listPublished(before), !before));
      } else {
        const match = /^\/posts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
        response = match ? respond(postPage(site, await posts.getPublished(match[1]!))) : respond(errorPage(site, "Not found"), 404);
      }
    } catch (error) {
      if (error instanceof PostError) {
        response = error.code === "not_found" ? respond(errorPage(site, "Not found"), 404) : respond(errorPage(site, "Invalid pagination cursor"), 400);
      } else {
        console.error("Public request failed", error instanceof Error ? error.name : "unknown");
        response = respond(errorPage(site, "Unable to load posts"), 500);
      }
    }
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
  },
} satisfies ExportedHandler<Env>;
