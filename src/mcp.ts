import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { MAX_MARKDOWN_LENGTH, Posts } from "./posts";
import { PostError, type Env, type Post } from "./types";

const id = z.uuid();
const markdown = z.string().max(MAX_MARKDOWN_LENGTH).refine((value) => value.trim().length > 0, "Post Markdown must not be empty.");
const version = z.number().int().positive();
const postSchema = z.object({
  id,
  markdown: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  version,
  url: z.string(),
});
const postResultSchema = z.object({ post: postSchema });

export function createServer(env: Env): McpServer {
  const posts = new Posts(env.DB);
  const publicPost = (post: Post) => ({ ...post, url: `https://${env.PUBLIC_HOST}/posts/${post.id}` });
  const server = new McpServer({ name: "noax.is", version: "0.1.0" }, {
    instructions: "Manage the single-author noax.is microblog. create_post immediately publishes publicly; update_post changes a live post; delete_post permanently deletes it. Publish or delete only when the user requests that action. Review drafts in the conversation. Read get_post before editing/deleting and pass its version as expected_version. On conflict, fetch and review again; do not blindly retry. If creation times out, list posts before retrying to avoid duplicates.",
  });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  const result = async (operation: () => Promise<Record<string, unknown>>) => {
    try {
      const output = await operation();
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      const output = { error: {
        code: error instanceof PostError ? error.code : "internal",
        message: error instanceof PostError ? error.message : "The operation failed. Read the current post before retrying a write.",
      } };
      if (!(error instanceof PostError)) console.error("Post operation failed", error instanceof Error ? error.name : "unknown");
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
  return server;
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return createMcpHandler(() => createServer(env))(request, env, ctx);
}
