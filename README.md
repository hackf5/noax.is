# noax.is

A minimal single-author microblog: one Cloudflare Worker, one D1 database, and five MCP publishing tools. Posts are Markdown stored in D1. Creating a post publishes it immediately.

- Public timeline: https://noax.is
- Individual posts: `https://noax.is/posts/{id}`
- Private MCP: `https://mcp.noax.is/mcp`, protected by Cloudflare Access Service Auth

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

Load the Access service token into the environment before launching the harness:

```sh
set -a
. .local/mcp.env
set +a
```

For Codex, merge [examples/codex.toml](examples/codex.toml) into your user or trusted project MCP configuration. For Claude Code, merge [examples/claude.mcp.json](examples/claude.mcp.json) into `.mcp.json`. The examples contain environment-variable references, never credentials.

Both connect directly over Streamable HTTP. An OAuth login or a custom publishing CLI is unnecessary. See the official [Codex MCP configuration](https://developers.openai.com/codex/mcp) and [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json).

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
