# noax.is

Noax.is is a minimal, extensible microblog that you can host for free (excluding domain costs).

Since you do almost everything else through your coding agent, why are you messing around with an admin dashboard and typing into a prosemirror wrapper? Exactly, you're not. The browser and the mouse are so yesterday.

You tell the coding agent to make a post, it makes that post. You tell the agent you want a new feature (a search box, an image gallery) it makes it. One Cloudflare Worker, D1 for posts, and optional R2 for images. The world is yours.

See it running at [noax.is](https://noax.is).

The text below is for your agent, not you. TL;DR; fellow thetan. Leave the "details" to the big guy/gal. Your squishy organic brain is too valuable to be worrying about bash scripts and CSS grids (snooze). If you can dream it you (the agent) can make it.

Stop reading now and point the agent at this page. It will take it from here.

## How it works

- **The public site** is server-rendered HTML with a strict Content Security Policy and an Atom feed at `/feed.xml`.
- **Agents** can read every page as Markdown, and find their way around with `/llms.txt`, `/robots.txt` and `/sitemap.xml`.
- **Publishing** happens through a private MCP endpoint on its own hostname, protected by Cloudflare Access.
- **Posts** are Markdown stored in D1, not in Git, so publishing needs no deploy. Creating a post publishes it immediately.

Your blog's settings and credentials stay in an ignored `.local/` directory, so you can `git pull` updates without conflicts.

## What you need

- **A domain** on an active Cloudflare zone. The blog can be at the apex or on a subdomain. The hostnames you choose mustn't have existing CNAME records.
- **A Zero Trust organisation.** Create one once at [one.dash.cloudflare.com](https://one.dash.cloudflare.com). Cloudflare asks for payment details even on the Free plan, but doesn't charge for it.
- **Node.js 24 or newer.**
- **A Cloudflare API token** with the permissions below.
- **An MCP client** that can send custom headers. Claude Code and Codex are configured for you.

### API token

Create a token in the Cloudflare dashboard with these permissions.

| Scope | Permission | Used for |
| --- | --- | --- |
| Account | Workers Admin | Creating and deploying the Worker, checking domain bindings |
| Account | D1: Edit | Creating the database, running migrations |
| Account | Access: Apps and Policies: Edit | Protecting the MCP hostname |
| Account | Access: Service Tokens: Edit | Creating your publishing credential |
| Account | Access: Organizations, Identity Providers, and Groups: Read | Finding your Access team |
| Zone | Zone: Read | Finding your zone |
| Zone | Workers Routes: Edit | Attaching your hostnames |

The Worker never uses this token, and neither does publishing. You can delete it once setup finishes. You'll need a new one to deploy updates, run remote migrations or rotate credentials.

For the optional files extension, add these permissions. Scope the zone permissions to the zone containing the blog and media hostnames.

| Scope | Permission | Used for |
| --- | --- | --- |
| Account | Workers R2 Storage → Edit | Creating the R2 bucket and configuring its domain and CORS |
| Zone | DNS → Read | Checking the media hostname for conflicts |
| Zone | **Cache Settings → Edit** | Creating and updating the media Cache Rule |

Cloudflare's API calls the last permission `Cache Settings Write`. The token picker uses **Cache Settings**. The same provisioning token can serve both setup choices. [Cloudflare token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/#zone-permissions)

## Set up

```sh
git clone https://github.com/hackf5/noax.is.git
cd noax.is
npm ci
mkdir -p .local
cp site.example.json .local/site.json    # then edit it
cp .env.example .local/cloudflare.env    # then add your token and account ID
npm run setup
```

`npm run setup` creates the Access application, service token and D1 database, applies migrations, deploys the Worker and checks the connection. It's safe to run again, and it stops rather than take over a hostname that belongs to another Worker. Run `npm run cloudflare:inspect` first if you'd like to see what's on the account; it changes nothing.

If the final check says `fetch failed` on a first deploy, everything else is already done and the new hostname just isn't reachable from your machine yet. Its certificate usually takes a couple of minutes, but the check can run before the DNS record exists, and your machine may then remember that for up to 30 minutes. Wait, then run `npm run mcp:check`.

Coding agents can do most of this for you. `AGENTS.md` explains which steps need you and which they can run.

### Choose file support

Leave `files` null or omit it to set up a text-only blog. To include images, activate R2 in the Cloudflare dashboard, add the permissions above, and put a `files` object in `.local/site.json`. Choose a dedicated bucket and a free media hostname within the blog's zone. [Activate R2](https://developers.cloudflare.com/r2/get-started/)

```json
{
  "files": {
    "bucket_name": "my-blog-files",
    "media_host": "media.example.com"
  }
}
```

`npm run setup` creates the bucket, attaches the media hostname, and provisions the hostname-scoped Cache Rule and anonymous read CORS. The rule makes checksum URLs cache-eligible and keeps 404s out of the edge cache. Images carry `Cache-Control: public, max-age=31536000, immutable`. [R2 custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/) · [Cache Rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)

Cloudflare may still be activating the media hostname or its certificate when setup finishes. Run `npm run cloudflare:inspect` to check its status before verifying media URLs.

To **enable files later**, pull the latest release, run `npm ci`, add the same `files` object and token permissions, then rerun `npm run setup`. It reuses your D1 database and Access application and credential. Start a fresh harness session to discover the file tools. Keep the configured media hostname available for published image URLs.

### Enable optional analytics

For a new or existing blog, tell the agent to enable analytics. The author's one-time step is to create a dedicated Cloudflare token with **Zone → Analytics → Read**, scoped to **Include → Specific zone → your blog's zone**. Save it in the ignored `.local/analytics.secrets.json` file. The agent can prepare the file for you. [Cloudflare token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/#zone-permissions)

```json
{
  "NOAX_ANALYTICS_TOKEN": "your-zone-analytics-read-token"
}
```

The agent sets `analytics` to `true` in `.local/site.json` and runs `npm run setup`. Setup records the zone ID, checks that the token can read the traffic report, and installs the secret with the Worker. This works on the first deploy and when enabling analytics later. `npm run mcp:check` discovers the tool and runs a read-only smoke report. Start a fresh harness session for the new tool to appear. [Deploying Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)

Routine deploys can reuse the stored Worker secret when the local file is absent. To rotate the token, replace its value in `.local/analytics.secrets.json` and have the agent run `npm run deploy` and `npm run mcp:check`. Revoke the previous token after the smoke report succeeds. To turn reporting off, set `analytics` to `false` and deploy. Revoke the analytics token when retiring access.

Ask the agent for a traffic report. `get_traffic_report` defaults to the last seven complete UTC days and accepts `days` from 1 to 30. It reports estimated HTML page requests by day, top pages, devices, browsers, operating systems, and countries. The private MCP queries aggregate Cloudflare data on demand. Analytics adds no public-page tracking script, cookies, storage, or consent prompt. [Cloudflare GraphQL Analytics](https://developers.cloudflare.com/analytics/graphql-api/)

## Publish

Start your client from the repository root:

```sh
claude
# or
codex
```

Use a fresh session after setup. Your client may ask you to approve the project's `noax` MCP server the first time.

Then say something like "We're about to draft a new article about ...", develop the text in the conversation, and say "post it" when it's ready. The agent publishes the agreed Markdown, checks the public page and gives you the URL.

To give your agent a house style, copy `EDITORIAL.example.md` to `EDITORIAL.md` and fill it in. It's ignored by Git and read in editorial sessions.

| Tool | Arguments | Effect |
| --- | --- | --- |
| `list_posts` | Optional `cursor`, `limit` (1–100; default 20) | Read newest first; follow `next_cursor` for older posts. |
| `get_post` | `id` | Read Markdown, metadata, current version and public URL. |
| `create_post` | `markdown` | Publish immediately. |
| `update_post` | `id`, `markdown`, `expected_version` | Replace the live Markdown. |
| `delete_post` | `id`, `expected_version` | Delete permanently. |

Posts must contain text and fit within 64,000 characters. Markdown supports paragraphs, headings, emphasis, lists, quotes, links and code. The optional files extension adds image shortcodes. A post's page title comes from its first top-level H1 (`# Title`), and its description comes from the body text.

The title also supplies the initial public URL, `/posts/{slug}`, and the homepage heading links to it. Slugs use lowercase ASCII words separated by hyphens and normalise accents. Titles can repeat but slugs can't, so a duplicate gets the next number after the highest in use. A post without an H1 uses the title `Post` and base slug `post`. Editing a heading changes the page title while preserving the published URL. MCP results include `slug` and the canonical `url`; `id` remains the UUID used for reading, editing and deleting through MCP. Older UUID URLs redirect permanently to the slug URL.

### Add images to a post

Give the agent a direct HTTPS image link, a path, or a pasted image whose local path the harness exposes. The agent runs the upload helper and uses the returned SHA-256 `id` in the Markdown. If the harness only exposes a preview, save the image to a file and give the agent its path. An uploaded image is publicly accessible at its media URL as soon as R2 stores it, including before publication.

```sh
npm run files:upload -- --path ./image.png
npm run files:upload -- --url https://example.com/image.webp
```

Use one shortcode per standalone block, with a blank line around it. Provide descriptive alt text or use `alt ""` for a decorative image.

```text
{% file <sha256> | image | alt "A red kite over the shoreline" %}
{% file <sha256> | ascii bw | alt "A red kite over the shoreline" %}
{% file <sha256> | ascii color | alt "A red kite over the shoreline" %}
```

Uploads accept PNG, JPEG, and WebP up to 8 MiB, 4,096 pixels per axis, and 12 megapixels. Image dimensions must be readable in the first 256 KiB. Identical bytes share a file ID and may appear in multiple posts. A post can contain up to 12 file blocks. ASCII is selectable text, with the original image as its fallback.

The helper calls `begin_file_upload` and streams bytes to the returned Access-protected URL. The other file tools are `get_file`, `list_files` with `unused_only` and `next_cursor`, and `delete_file` with the `expected_version` from `get_file`. Only unused files can be deleted. After an upload timeout, rerun the helper with the same bytes to check whether R2 committed the upload. Retry a deletion with the same version to check whether the object was removed. If an operation stays pending, inspect R2 and the Worker logs before repairing the D1 record.

Deleting a file removes its bytes from R2. Cloudflare and browsers can still serve cached copies. A Cloudflare cache purge clears the edge cache, while browser copies may remain until their immutable TTL expires. [R2 cache consistency](https://developers.cloudflare.com/r2/reference/consistency/#caching) · [Browser Cache TTL](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/)

## Read it as an agent

Every page has a Markdown version. A post is its source exactly as written, beneath front matter giving its title, description, URL and dates. That means it shows anything in a post that the HTML page doesn't.

| URL | What it gives |
| --- | --- |
| `/`, `/posts/<slug>` with `Accept: text/markdown` | The page as Markdown. `Accept: text/plain` gets the same text as `text/plain`. |
| `/index.md`, `/posts/<slug>.md` | The same, for clients that can't set headers. |
| `/llms.txt` | A guide for agents, with the newest posts. |
| `/robots.txt` | Crawl rules, your `content_signal` and the sitemap's location. |
| `/sitemap.xml` | An index of sitemaps, each listing up to 1,000 posts. |

Browsers, and any client that doesn't ask for Markdown or prefer plain text, get HTML.

Cloudflare can add its own text above your `robots.txt`, depending on the zone's AI crawler settings. `npm run smoke` checks that the `Sitemap:` line survives.

## Configure

Settings live in `.local/site.json`. Run `npm run deploy` after changing them.

| Key | Default | Purpose |
| --- | --- | --- |
| `public_host` | Required | Where the blog is served. |
| `mcp_host` | `mcp.` + `public_host` | The private publishing hostname. Must be in the same zone. |
| `title` | `public_host` | Shown in the header, page titles and feed. |
| `description` | `Notes on` + `title` | The default page description and feed subtitle. |
| `locale` | `en` | Page language and date format. Times are shown in UTC. |
| `content_signal` | `search=yes, ai-input=yes` | How AI systems may use your posts, published in `robots.txt`. Add `ai-train=yes` or `ai-train=no` to state a preference on training. Compliance is voluntary. |
| `files` | `null` | Enable R2 images by setting `bucket_name` and `media_host`. Apply this setting with `npm run setup`. |
| `analytics` | `false` | Enable private MCP traffic reports using Cloudflare Analytics. Apply this setting with `npm run setup`. |

If you change `mcp_host`, also update `NOAX_MCP_URL` in `.local/mcp.env` and run `npm run cloudflare:provision`.

The styling is one stylesheet in `src/html.ts`. Fork the repository if you want to keep changes to the code.

## Costs

noax is designed to fit Cloudflare's free allowances. The optional R2 extension uses Standard storage and bills for usage above its free allowance. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

| Limit on the Free plan | Allowance |
| --- | --- |
| Worker requests | 100,000 a day |
| Worker CPU | 10 ms per request |
| D1 rows read | 5 million a day |
| D1 rows written | 100,000 a day |
| D1 database size | 500 MB |

A page view normally costs one Worker request, as browsers cache the stylesheet and favicons. The stylesheet's URL changes with its content, so browsers can keep it for good and still pick up changes straight away. Posts are rendered when they're written, so reading the site does no Markdown work.

The browser fetches images directly from the media hostname. Cloudflare CDN hits save R2 reads, and the Worker does no per-image work. Pages with ASCII blocks load a small script to convert the same image in the browser.

The feed, `llms.txt`, sitemaps, `robots.txt`, the stylesheet and favicons go through [Workers Cache](https://developers.cloudflare.com/workers/cache/), which sits in front of the Worker. A cache hit uses no Worker CPU and no D1 reads, though Cloudflare still bills it as a request, so assume it counts towards the daily limit. Each deploy starts with an empty cache. The feed, `llms.txt` and sitemaps can lag by up to five minutes, so a deleted post can linger in them briefly. Pages and Markdown aren't cached, so edits and deletions show on the next request.

Rendered output is a cache, so posts pick up rendering changes automatically after an update. Each post is rebuilt the first time it's read and saved straight away. On the Free plan, a page of long posts can exceed the CPU limit while this happens and show a Cloudflare error. No work is lost, though, so the page loads after a few refreshes.

If you go over a daily limit on the Free plan, you get errors rather than a bill, and the limits reset at 00:00 UTC. The Worker has no rate limiting of its own, so anyone sending enough requests can use up the day's allowance.

Sitemaps cost more than pages. A full sitemap file reads 1,000 rows and `/sitemap.xml` reads every post, where a page reads about 20. The cache means repeat requests read D1 about once every five minutes rather than every time, but it isn't a rate limit. The query string and some headers are part of its key, so someone deliberately varying them still reaches D1. On a blog with thousands of posts, about 5,000 such requests would use up the day's D1 reads, and every page would fail until the reset. Sitemaps are split so that each request stays within the CPU limit however many posts there are.

These limits come from Cloudflare's [Workers](https://developers.cloudflare.com/workers/platform/limits/) and [D1](https://developers.cloudflare.com/d1/platform/limits/) documentation. Check there for current figures.

## Operate

### Update

```sh
git pull
npm ci
npm run db:migrate:remote
npm run db:backfill-slugs:remote
npm run deploy
npm run db:backfill-slugs:remote
```

Run the migration first. This needs an API token in `.local/cloudflare.env`.

The slug migration allows null values so the previous Worker can keep publishing during deployment. The idempotent backfill assigns slugs in publication order without changing Markdown, timestamps or versions. Run it before deployment and again afterwards to cover posts created by the previous Worker during rollout; it checks that no posts without slugs remain. Until backfilled, legacy posts keep their UUID URLs. The remote backfill uses the provisioning credentials, separately from the MCP Access service token.

### Back up

Posts exist only in D1, and deleting one is permanent. D1 Time Travel keeps 7 days of history on the Free plan and 30 on paid plans. To export a copy:

```sh
node --env-file=.local/cloudflare.env node_modules/wrangler/bin/wrangler.js d1 export DB \
  --remote --output .local/backup.sql --config .local/wrangler.deploy.jsonc
```

With files enabled, back up the R2 objects alongside that export. Pause writes while taking a matching copy. For each ready row in `files`, save the object by its `id`. To restore, use the same checksum key and the row's `content_type`, then verify the public media URL before restoring the D1 posts and references that point to it. [Wrangler R2 commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/)

```sh
node --env-file=.local/cloudflare.env node_modules/wrangler/bin/wrangler.js r2 object get \
  "$bucket/$id" --remote --file ".local/backup-files/$id"

# Verify the input file's SHA-256 is $id before restoring it.
node --env-file=.local/cloudflare.env node_modules/wrangler/bin/wrangler.js r2 object put \
  "$bucket/$id" --remote --file ".local/backup-files/$id" --content-type "$content_type" \
  --cache-control 'public, max-age=31536000, immutable'
```

### Look after `.local/`

| File | Contains | If you lose it |
| --- | --- | --- |
| `site.json` | Your blog's settings | Recreate it from `site.example.json`. |
| `cloudflare.env` | Your API token | Create a new token. |
| `mcp.env` | Your publishing credential | Run `npm run cloudflare:rotate`. |
| `analytics.secrets.json` | Optional dedicated analytics token | Deploys reuse the stored Worker secret. Create a new token when rotating it. |
| `provisioning.json` | Cloudflare resource IDs | Run `npm run cloudflare:provision`. |
| `wrangler.deploy.jsonc` | Generated deploy config | It's regenerated on every deploy. |

`.mcp.json` and `.codex/config.toml` are generated in the same way. Back up `.local/` and `EDITORIAL.md` with your other secrets, as a new checkout needs them.

Don't run `scripts/mcp-headers.mjs` directly in a logged shell, because its output is your credential. Use `npm run mcp:check`.

### Renew the publishing credential

The Access service token lasts a year, and publishing stops when it expires. `npm run mcp:check` warns you 30 days ahead. `npm run cloudflare:rotate` issues a new secret and extends the expiry, and only needs a token with Access: Service Tokens: Edit.

### Verify a deployment

`npm run smoke` checks publishing and agent access end to end. It briefly publishes a clearly labelled post, tests editing and conflict handling, and deletes it, so only run it if a short-lived public post is acceptable.

## Develop

```sh
npm ci
npm run db:migrate:local
npm run db:backfill-slugs:local
npm run dev
```

Open `http://localhost:8787`. All of this works on a fresh clone with no Cloudflare account, using a local database. MCP authentication stays on locally, so to see a post, add one directly:

```sh
npx wrangler d1 execute DB --local --command "INSERT INTO posts (id, markdown, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', '# Hello', strftime('%Y-%m-%dT%H:%M:%fZ'), strftime('%Y-%m-%dT%H:%M:%fZ'))"
```

Before sending a change:

```sh
npm run typecheck
npm test
npm run build
```

The tests cover the full MCP protocol with generated signing keys, and provisioning against a fake Cloudflare API.

## Scope

Minimalism is the point. noax is a single-author blog with optional image storage. Bug fixes and changes that make it smaller or easier to run are very welcome. Please open an issue before starting anything larger.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE)
