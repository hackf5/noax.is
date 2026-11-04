# noax.is

A minimal single-author microblog: one Cloudflare Worker, one D1 database, and five MCP publishing tools. Posts are Markdown stored in D1. Creating a post publishes it immediately.

- Public timeline: https://noax.is
- Individual posts: `https://noax.is/posts/{id}`
- Private MCP: `https://mcp.noax.is/mcp`, protected by Cloudflare Access Service Auth

## Writing for No Axis

The current purpose of No Axis is balanced discussion of potentially polarising issues: start without a predetermined angle, present the arguments as the author sees them, and draw the conclusions the reasoning supports. The editorial brief and publishing workflow live in [AGENTS.md](AGENTS.md); Claude Code is directed there by [CLAUDE.md](CLAUDE.md).

Start a new chat in this repository with, for example, "We're about to draft a new article about ...". Develop the text in the conversation. When it is ready, say "post it". The harness should publish the final agreed Markdown, check the public page and return its URL. That instruction is sufficient authorization; article publication requires no code deployment.

## Local development

Requires Node.js 24 or newer.

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open `http://localhost:8787`. The development command preserves the local origin and sets the public hostname to `localhost`; production domain settings remain in `wrangler.jsonc`. D1 state is local; production data is not used. MCP authentication stays enabled locally. The integration tests exercise its full protocol with generated signing keys and a mocked Access JWKS endpoint.

```sh
npm run typecheck
npm test
npm run build
```

## Connect a coding harness

The repository includes project configurations for [Codex](.codex/config.toml) and [Claude Code](.mcp.json). Both use a local headers helper to read the publishing credentials from `.local/mcp.env` automatically. Credentials stay outside the committed configuration; you do not need to export variables before each session.

Start the CLI from the repository root:

```sh
codex
# or
claude
```

Use a fresh session after changing MCP configuration. Codex loads project configuration for trusted projects; Claude Code may ask you to approve the project's `noax` MCP server the first time. This is the client's project-trust step.

Check authentication and tool discovery without publishing anything:

```sh
npm run mcp:check
```

Do not run `scripts/mcp-headers.mjs` directly in a logged shell: its stdout is the credentials JSON intended for the MCP client. Use `mcp:check` for diagnostics. A new checkout needs its own ignored `.local/mcp.env`, restored through your normal secret-management process. Header helpers require Node.js 24 or newer; the connection-check command also needs `npm ci`.

Both clients connect directly over Streamable HTTP. See the official [Codex MCP configuration](https://developers.openai.com/codex/mcp) and [Claude Code headers helper documentation](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication).

| Tool | Arguments | Effect |
| --- | --- | --- |
| `list_posts` | Optional `cursor`, `limit` (1–100; default 20) | Read newest first; follow `next_cursor` for older posts. |
| `get_post` | `id` | Read Markdown, metadata, current version and public URL. |
| `create_post` | `markdown` | Publish immediately. |
| `update_post` | `id`, `markdown`, `expected_version` | Replace the live Markdown. |
| `delete_post` | `id`, `expected_version` | Delete permanently. |

Prepare drafts in the conversation. Read before editing/deleting; a version conflict requires reviewing the newer post. If creation times out, list posts before retrying. Post bodies must contain non-whitespace text and fit within 64,000 characters. Markdown supports paragraphs, headings, emphasis, lists, quotes, links and code; raw HTML and image rendering are disabled.

Successful tools return structured JSON; operation failures have `isError: true` and an `error` with a code and message. SDK input-validation failures are also returned as MCP tool errors.

## Cloudflare setup and deployment

Put `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in `.local/cloudflare.env`. This file is ignored. Provisioning credentials are separate from the service token used for publishing.

```sh
npm run cloudflare:inspect
npm run cloudflare:provision
npm run db:migrate:remote
npm run deploy
npm run smoke
```

Provisioning creates the named D1 database, Access application and one-year service token, protecting the entire MCP hostname before it is deployed. It saves the service-token secret once to `.local/mcp.env` with mode `0600` and writes only non-secret identifiers into `wrangler.jsonc`. Back up the local credentials through your normal secret-management process. Restore that file or deliberately rotate the service token if it is lost; provisioning will not silently replace credentials.

The Worker validates Access JWT signatures, issuer, expiry and application audience. `workers.dev` and preview URLs are disabled. Only `mcp.noax.is/mcp` dispatches publishing tools. Public responses use `Cache-Control: no-store`, so edits and deletions appear on the next request.

The live smoke test briefly publishes an explicitly labelled verification post, exercises reading/editing/conflict rejection, and deletes it. It never changes existing posts. Do not run it unless temporary public verification is intended.

Renew or rotate the Access service token before its expiry. Its resource ID and expiry are recorded in `.local/provisioning.json`. A code rollback does not roll back D1 data; SQL migrations are tracked separately. Before future destructive schema changes, export or otherwise establish a recovery point.

Cut 1 has no dashboard, drafts, feeds, images, tags or search.

The open-ring favicon is drawn in `src/assets/favicon.svg`. Its ICO fallback contains 16×16 and 32×32 raster exports of the same mark; regenerate both sizes if the SVG changes. Both assets are bundled into the Worker and served directly without D1 access.
