import { authenticate } from "./auth";
import { errorPage, postPage, stylesheet, timeline } from "./html";
import { handleMcp } from "./mcp";
import { Posts } from "./posts";
import { PostError, type Env } from "./types";

const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

function respond(body: string, status = 200, type = "text/html; charset=utf-8"): Response {
  return new Response(body, { status, headers: { ...securityHeaders, "Content-Type": type } });
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
      return new Response("Method not allowed", { status: 405, headers: { ...securityHeaders, Allow: "GET, HEAD" } });
    }
    let response: Response;
    try {
      const posts = new Posts(env.DB);
      if (url.pathname === "/style.css") response = respond(stylesheet, 200, "text/css; charset=utf-8");
      else if (url.pathname === "/") response = respond(timeline(await posts.list(url.searchParams.get("before") ?? undefined)));
      else {
        const match = /^\/posts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
        response = match ? respond(postPage(await posts.get(match[1]!))) : respond(errorPage("Not found"), 404);
      }
    } catch (error) {
      if (error instanceof PostError) {
        response = error.code === "not_found" ? respond(errorPage("Not found"), 404) : respond(errorPage("Invalid pagination cursor"), 400);
      } else {
        console.error("Public request failed", error instanceof Error ? error.name : "unknown");
        response = respond(errorPage("Unable to load posts"), 500);
      }
    }
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
  },
} satisfies ExportedHandler<Env>;
