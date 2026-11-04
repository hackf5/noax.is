# noax.is

A single-author Markdown microblog. D1 is the authoritative content store; posts do not live in Git. One TypeScript Worker serves public HTML and a private stateless MCP endpoint.

## Editorial purpose

No Axis is a place for balanced discussion of potentially polarising issues. Start without a predetermined angle, present the arguments as the author sees them, and draw the conclusions the reasoning supports. Balanced discussion does not require giving every argument equal weight or reaching a compromise position.

Help the author examine and develop their own thinking. Preserve their voice and judgement, distinguish evidence from inference, and make uncertainty clear. Verify factual claims and cite sources when the discussion depends on them.

## Editorial workflow

- A session about drafting an article is an editorial session. Develop and revise the Markdown in the conversation; publishing is a content operation through the existing MCP server.
- `create_post` publishes immediately. An instruction such as "post it" or "publish it" authorizes publishing the final agreed Markdown, including any agreed heading and source links, without another confirmation.
- Publish the agreed text exactly. After publication, check the public URL and return it to the user. Report a failed verification accurately rather than creating another post.
- Before editing or deleting, call `get_post` and pass its `version` as `expected_version`.
- `delete_post` permanently removes the post. Call it only when the user requests deletion.
- A version conflict requires reading and reviewing the latest post. Never blindly retry.
- After a creation timeout, inspect `list_posts` before retrying to avoid duplicate posts.
- Use the five MCP tools for editorial work. Keep Cloudflare provisioning credentials separate from the Access service token.

## Harness connection

- Project MCP configurations are in `.codex/config.toml` and `.mcp.json`. Start the harness from the repository root.
- Both clients run `scripts/mcp-headers.mjs` to read the Access service token from the ignored `.local/mcp.env`; manually exporting credentials is unnecessary.
- Use `npm run mcp:check` for a read-only connection and tool-discovery check. It does not publish or modify posts.
- The headers helper's stdout contains credentials for the MCP client. Never run it directly in a logged shell or print its output. Use the read-only connection check for diagnostics.
- A fresh harness session is required after changing MCP configuration. If tools are unavailable, resolve the connection before promising that an article can be published.

## Development

- Keep the implementation small: server-rendered HTML, system fonts, basic Markdown, plain prepared SQL.
- Use Context7 to verify current library, SDK, CLI and cloud-service documentation before using their APIs.
- Run `npm run typecheck`, `npm test`, and `npm run build` after functional changes.
- Run `npm run db:migrate:local` before `npm run dev`. Local publishing is tested through the authenticated integration suite; production Access authentication is never disabled for local development.
- Public routes must never dispatch MCP operations. All deployed MCP requests require a verified Cloudflare Access JWT.
- `.local/`, `.dev.vars`, and environment files contain credentials and must stay ignored. Never print token values or commit them.
- Provisioning must not overwrite another Worker's domain bindings or broaden existing Access policies.
