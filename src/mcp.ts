import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { AnalyticsError, DEFAULT_REPORT_DAYS, getTrafficReport, MAX_REPORT_DAYS, TRAFFIC_REPORT_TOOL, trafficReportSchema } from "./analytics";
import { FILE_ID, IMAGE_TYPES, MAX_FILE_BYTES } from "./files/image";
import { filesFrom } from "./files/store";
import { MAX_MARKDOWN_LENGTH, Posts } from "./posts";
import { postPath } from "./post-metadata";
import { PostError, type Env, type Post } from "./types";

const id = z.uuid();
const markdown = z.string().max(MAX_MARKDOWN_LENGTH).refine((value) => value.trim().length > 0, "Post Markdown must not be empty.");
const version = z.number().int().positive();
const postSchema = z.object({
  id,
  slug: z.string().nullable(),
  markdown: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  version,
  url: z.string(),
});
const postResultSchema = z.object({ post: postSchema });
const fileId = z.string().regex(FILE_ID);
const fileInput = z.object({
  id: fileId,
  filename: z.string().min(1).max(255),
  content_type: z.enum(IMAGE_TYPES),
  byte_size: z.number().int().min(1).max(MAX_FILE_BYTES),
});
const fileSchema = fileInput.extend({
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  version: z.uuid(),
  state: z.enum(["pending", "uploading", "ready", "deleting"]),
  created_at: z.string(),
  ready_at: z.string().nullable(),
  url: z.string().nullable(),
});

export function createServer(env: Env, ctx?: ExecutionContext): McpServer {
  const files = filesFrom(env);
  const posts = new Posts(env.DB, undefined, files);
  const publicPost = (post: Post) => ({ ...post, url: `https://${env.PUBLIC_HOST}${postPath(post)}` });
  const server = new McpServer({ name: env.SITE_TITLE, version: "0.1.0" }, {
    instructions: `Manage the single-author ${env.SITE_TITLE} microblog. create_post immediately publishes publicly; update_post changes a live post; delete_post permanently deletes it. Publish or delete only when the user requests that action. Review drafts in the conversation. Read get_post before editing/deleting and pass its version as expected_version. On conflict, fetch and review again; do not blindly retry. If creation times out, list posts before retrying to avoid duplicates.${files ? ' Images are public on upload. Use npm run files:upload with --path or --url, then use a standalone {% file <sha256> | image | alt "Description" %} block. Try ascii bw or ascii color for ASCII art. For deletion, read get_file first and pass expected_version only when the user requests deletion.' : ""}`,
  });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  const result = async (operation: () => Promise<Record<string, unknown>>) => {
    try {
      const output = await operation();
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      const expected = error instanceof PostError || error instanceof AnalyticsError;
      const output = { error: {
        code: expected ? error.code : "internal",
        message: expected ? error.message : "The operation failed. Check the current state before retrying a write.",
      } };
      if (!expected) console.error("MCP operation failed", error instanceof Error ? error.name : "unknown");
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    }
  };

  server.registerTool("list_posts", {
    description: "Read published posts newest first. Pass next_cursor to read the next page.",
    inputSchema: z.object({ cursor: z.string().max(512).optional(), limit: z.number().int().min(1).max(100).optional() }),
    outputSchema: z.object({ posts: z.array(postSchema), next_cursor: z.string().nullable() }),
    annotations: readOnly,
  }, ({ cursor, limit }) => result(async () => {
    const page = await posts.list(cursor, limit);
    return { ...page, posts: page.posts.map(publicPost) };
  }));
  server.registerTool("get_post", {
    description: "Read the original Markdown and current version of a published post before editing or deleting it.",
    inputSchema: z.object({ id }), outputSchema: postResultSchema, annotations: readOnly,
  }, ({ id }) => result(async () => ({ post: publicPost(await posts.get(id)) })));
  server.registerTool("create_post", {
    description: "Immediately publish a new public Markdown post. Call only when the user requests publication. Not retry-safe: after a timeout, list_posts to check whether it was created before trying again.",
    inputSchema: z.object({ markdown }), outputSchema: postResultSchema,
    annotations: { ...write, destructiveHint: false },
  }, ({ markdown }) => result(async () => ({ post: publicPost(await posts.create(markdown)) })));
  server.registerTool("update_post", {
    description: "Replace a live post's Markdown using the version from get_post. Changes are immediately public. A conflict requires fetching and reviewing the current post.",
    inputSchema: z.object({ id, markdown, expected_version: version }), outputSchema: postResultSchema, annotations: write,
  }, ({ id, markdown, expected_version }) => result(async () => ({ post: publicPost(await posts.update(id, markdown, expected_version)) })));
  server.registerTool("delete_post", {
    description: "Permanently delete a public post using the version from get_post. There is no undo. Call only when the user requests deletion.",
    inputSchema: z.object({ id, expected_version: version }),
    outputSchema: z.object({ deleted: z.literal(true), id }), annotations: write,
  }, ({ id, expected_version }) => result(async () => {
    await posts.delete(id, expected_version);
    return { deleted: true, id };
  }));
  if (files) {
    server.registerTool("begin_file_upload", {
      description: "Reserve a PNG, JPEG or WebP by its SHA-256 checksum. The returned URL accepts a raw PUT with the same Access credentials. Use the ready file directly when upload_url is null. Bytes become public when stored.",
      inputSchema: fileInput,
      outputSchema: z.object({ file: fileSchema, upload_url: z.string().nullable() }),
      annotations: { ...write, destructiveHint: false, idempotentHint: true },
    }, (input) => result(() => files.begin(input, env.MCP_HOST)));
    server.registerTool("get_file", {
      description: "Read an image's metadata, public URL, and current version before deleting it.",
      inputSchema: z.object({ id: fileId }), outputSchema: z.object({ file: fileSchema }), annotations: readOnly,
    }, ({ id }) => result(async () => ({ file: await files.get(id) })));
    server.registerTool("list_files", {
      description: "List uploaded images and pending reservations newest first. Use unused_only to find files with no post references, and next_cursor for the next page.",
      inputSchema: z.object({ cursor: z.string().max(89).optional(), limit: z.number().int().min(1).max(100).optional(), unused_only: z.boolean().optional() }),
      outputSchema: z.object({ files: z.array(fileSchema), next_cursor: z.string().nullable() }), annotations: readOnly,
    }, ({ cursor, limit = 20, unused_only = false }) => result(() => files.list(cursor, limit, unused_only)));
    server.registerTool("delete_file", {
      description: "Delete an unused image or discard a pending reservation. Call only when requested. Use expected_version from get_file. CDN and browser copies can remain until their cache expires.",
      inputSchema: z.object({ id: fileId, expected_version: z.uuid() }),
      outputSchema: z.object({ deleted: z.literal(true), id: fileId }), annotations: write,
    }, ({ id, expected_version }) => {
      const work = result(async () => {
        await files.delete(id, expected_version);
        return { deleted: true, id };
      });
      ctx?.waitUntil(work);
      return work;
    });
  }
  const { ANALYTICS_ZONE_ID: zone, NOAX_ANALYTICS_TOKEN: token } = env;
  if (zone && token) {
    server.registerTool(TRAFFIC_REPORT_TOOL, {
      description: "Read estimated HTML page requests for complete UTC days, grouped by date, page, device, browser, OS and country. Cloudflare samples traffic. Defaults to the last seven complete days.",
      inputSchema: z.object({ days: z.number().int().min(1).max(MAX_REPORT_DAYS).optional() }),
      outputSchema: trafficReportSchema,
      annotations: { ...readOnly, openWorldHint: true },
    }, ({ days = DEFAULT_REPORT_DAYS }) => result(() => getTrafficReport({ zone, token, hostname: env.PUBLIC_HOST }, days)));
  }
  return server;
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return createMcpHandler(() => createServer(env, ctx))(request, env, ctx);
}
