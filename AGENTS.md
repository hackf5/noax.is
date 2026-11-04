# noax.is

A single-author Markdown microblog. D1 is the authoritative content store; posts do not live in Git. One TypeScript Worker serves public HTML and a private stateless MCP endpoint.

## Editorial workflow

- Draft wording in the conversation. `create_post` publishes immediately; call it only when the user requests publication.
- Before editing or deleting, call `get_post` and pass its `version` as `expected_version`.
- `delete_post` permanently removes the post. Call it only when the user requests deletion.
- A version conflict requires reading and reviewing the latest post. Never blindly retry.
- After a creation timeout, inspect `list_posts` before retrying to avoid duplicate posts.
- Use the five MCP tools for editorial work. Keep Cloudflare provisioning credentials separate from the Access service token.

## Development

- Keep the implementation small: server-rendered HTML, system fonts, basic Markdown, plain prepared SQL.
- Use Context7 to verify current library, SDK, CLI and cloud-service documentation before using their APIs.
- Run `npm run typecheck`, `npm test`, and `npm run build` after functional changes.
- Run `npm run db:migrate:local` before `npm run dev`. Local publishing is tested through the authenticated integration suite; production Access authentication is never disabled for local development.
- Public routes must never dispatch MCP operations. All deployed MCP requests require a verified Cloudflare Access JWT.
- `.local/`, `.dev.vars`, and environment files contain credentials and must stay ignored. Never print token values or commit them.
- Provisioning must not overwrite another Worker's domain bindings or broaden existing Access policies.
