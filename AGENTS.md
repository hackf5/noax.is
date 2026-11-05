# noax

A single-author Markdown microblog. D1 is the authoritative content store; posts do not live in Git. One TypeScript Worker serves public HTML and a private stateless MCP endpoint.

This repository is generic. Everything specific to one blog lives outside Git: its configuration and credentials in `.local/`, and its editorial brief in `EDITORIAL.md`.

## Editorial workflow

- A session about drafting an article is an editorial session. If `EDITORIAL.md` exists at the repository root, read it first and follow it. If it doesn't, ask the author what the blog is for rather than assuming.
- Develop and revise the Markdown in the conversation; publishing is a content operation through the existing MCP server.
- `create_post` publishes immediately. An instruction such as "post it" or "publish it" authorizes publishing the final agreed Markdown, including any agreed heading and source links, without another confirmation.
- Publish the agreed text exactly. After publication, check the public URL and return it to the user. Report a failed verification accurately rather than creating another post.
- Before editing or deleting, call `get_post` and pass its `version` as `expected_version`.
- `delete_post` permanently removes the post. Call it only when the user requests deletion.
- A version conflict requires reading and reviewing the latest post. Never blindly retry.
- After a creation timeout, inspect `list_posts` before retrying to avoid duplicate posts.
- Use the five MCP tools for editorial work. Keep Cloudflare provisioning credentials separate from the Access service token.

## Setting up a new instance

Only the author can do these steps, so ask for them rather than attempting them:

1. Add the domain to Cloudflare, so its zone is active.
2. Create a Zero Trust organisation in the dashboard. Cloudflare asks for payment details even on the Free plan.
3. Create an API token with the permissions in the README, and put it in `.local/cloudflare.env`, using `.env.example` as the template.

Then you can do the rest:

1. Copy `site.example.json` to `.local/site.json` and fill in the author's hostnames, title, description and locale.
2. Run `npm run cloudflare:inspect` and report anything that looks like a conflict. It changes nothing.
3. With the author's agreement, run `npm run setup`. It provisions Cloudflare resources and deploys a public site.
4. If `mcp:check` fails straight after a first deploy, the new hostname's certificate may not be ready. Wait a few minutes and run `npm run mcp:check` again.
5. Tell the author to start a fresh harness session, as the MCP configuration has just been generated. Offer to help write `EDITORIAL.md`, starting from `EDITORIAL.example.md`.

## Harness connection

- `.mcp.json` and `.codex/config.toml` are generated and ignored; never hand-edit or commit them. Start the harness from the repository root.
- Both clients run `scripts/mcp-headers.mjs` to read the Access service token from the ignored `.local/mcp.env`; manually exporting credentials is unnecessary.
- Use `npm run mcp:check` for a read-only connection and tool-discovery check. It does not publish or modify posts.
- The headers helper's stdout contains credentials for the MCP client. Never run it directly in a logged shell or print its output. Use the read-only connection check for diagnostics.
- A fresh harness session is required after changing MCP configuration. If tools are unavailable, resolve the connection before promising that an article can be published.

## Development

- Keep the implementation small: server-rendered HTML, system fonts, basic Markdown, plain prepared SQL.
- Check current library, SDK, CLI and cloud-service documentation before using their APIs.
- Run `npm run typecheck`, `npm test`, and `npm run build` after functional changes.
- Run `npm run db:migrate:local` before `npm run dev`. Local publishing is tested through the authenticated integration suite; production Access authentication is never disabled for local development.
- Public routes must never dispatch MCP operations. All deployed MCP requests require a verified Cloudflare Access JWT.
- Keep instance data out of tracked files. `wrangler.jsonc` is a local development config; production values are generated into `.local/wrangler.deploy.jsonc` by `scripts/site-config.mjs`.
- Every page must exist as HTML and Markdown. Build responses with `htmlPage` and `markdownPage` in `src/index.ts`; `respond()` defaults to HTML, so never pass it Markdown without a type.
- HTML responses carry a fresh script nonce in the `Content-Security-Policy` header for the script Cloudflare injects. Keep HTML `no-store` so a nonce is never reused, and don't add `no-transform`, which stops the injection.
- Workers Cache sits in front of the Worker and follows `Cache-Control`, and its key ignores hostnames. Everything on `MCP_HOST` must stay `no-store`. Make a route cacheable only on purpose, and add it to the table in the cache headers test.
- Sitemaps and the Markdown timeline must never render, and a sitemap response must stay bounded by `SITEMAP_SIZE`, so a request's CPU doesn't grow with the number of posts. Write `SITEMAP_SIZE` into the SQL rather than binding it.
- Stored HTML, titles and summaries are a cache of the Markdown. Bump `RENDER_VERSION` in `src/render.ts` whenever rendered output changes; posts then rebuild as they're read.
- `.local/`, `.dev.vars`, and environment files contain credentials and must stay ignored. Never print token values or commit them.
- Provisioning must not overwrite another Worker's domain bindings or broaden existing Access policies.
