# noax.is

Noax.is is a minimal, extensible microblog that you can host for free (excluding domain costs).

Since you do almost everything else through your coding agent, why are you messing around with an admin dashboard and typing into a prosemirror wrapper? Exactly, you're not. The browser and the mouse are so yesterday.

You tell the coding agent to make a post, it makes that post. You tell the agent you want a new feature (a search box, an image gallery) it makes it. No frameworks, no plugins. Two cloudflare workers, D1 for persistence (maybe you'll need R2 for general storage) all on the free plan and that's it. The world is yours.

See it running at [noax.is](https://noax.is).

The text below is for your agent, not you. TL;DR; fellow thetan. Leave the "details" to the big guy/gal. Your squishy organic brain is too valuable to be worrying about bash scripts and CSS grids (snooze). If you can dream it you (the agent) can make it.

Stop reading now and point the agent at this page. It will take it from here.

## How it works

- **The public site** is server-rendered HTML with no JavaScript, a strict Content Security Policy and an Atom feed at `/feed.xml`.
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

Create a token in the Cloudflare dashboard with:

| Scope | Permission | Used for |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Deploying, checking domain bindings |
| Account | D1: Edit | Creating the database, running migrations |
| Account | Access: Apps and Policies: Edit | Protecting the MCP hostname |
| Account | Access: Service Tokens: Edit | Creating your publishing credential |
| Account | Access: Organizations: Read | Finding your Access team |
| Zone | Zone: Read | Finding your zone |
| Zone | Workers Routes: Edit | Attaching your hostnames |

The Worker never uses this token, and neither does publishing. You can delete it once setup finishes. You'll need a new one to deploy updates, run remote migrations or rotate credentials.

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

If the final check fails on a first deploy, the new hostname's certificate may not be ready. Wait a few minutes and run `npm run mcp:check`.

Coding agents can do most of this for you. `AGENTS.md` explains which steps need you and which they can run.

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

Posts must contain text and fit within 64,000 characters. Markdown supports paragraphs, headings, emphasis, lists, quotes, links and code. Raw HTML and images are disabled. A post's page title and description come from its first heading or line and the text that follows.

## Read it as an agent

Every page has a Markdown version. A post is its source exactly as written, beneath front matter giving its title, description, URL and dates. That means it shows anything in a post that the HTML page doesn't.

| URL | What it gives |
| --- | --- |
| `/`, `/posts/<id>` with `Accept: text/markdown` | The page as Markdown. `Accept: text/plain` gets the same text as `text/plain`. |
| `/index.md`, `/posts/<id>.md` | The same, for clients that can't set headers. |
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

If you change `mcp_host`, also update `NOAX_MCP_URL` in `.local/mcp.env` and run `npm run cloudflare:provision`.

For anything else, change the code. It's about 700 lines, and the styling is one stylesheet in `src/html.ts`. Fork the repository if you want to keep those changes.

## Costs

noax is designed to fit Cloudflare's free plans. The domain is the only thing you have to pay for.

| Limit on the Free plan | Allowance |
| --- | --- |
| Worker requests | 100,000 a day |
| Worker CPU | 10 ms per request |
| D1 rows read | 5 million a day |
| D1 rows written | 100,000 a day |
| D1 database size | 500 MB |

A page view normally costs one Worker request, as browsers cache the stylesheet and favicons for a day. Posts are rendered when they're written, so reading the site does no Markdown work.

Rendered output is a cache, so posts pick up rendering changes automatically after an update. Each post is rebuilt the first time it's read and saved straight away. On the Free plan, a page of long posts can exceed the CPU limit while this happens and show a Cloudflare error. No work is lost, though, so the page loads after a few refreshes.

If you go over a daily limit on the Free plan, you get errors rather than a bill, and the limits reset at 00:00 UTC. The Worker has no rate limiting of its own, so anyone sending enough requests can use up the day's allowance.

Sitemaps cost more than pages. A full sitemap file reads 1,000 rows and `/sitemap.xml` reads every post, where a page reads about 20. On a blog with thousands of posts, about 5,000 repeat requests would use up the day's D1 reads, and every page would fail until the reset. Cache headers don't prevent this, as the Worker still runs for each request. Sitemaps are split so that each request stays within the CPU limit however many posts there are.

These limits come from Cloudflare's [Workers](https://developers.cloudflare.com/workers/platform/limits/) and [D1](https://developers.cloudflare.com/d1/platform/limits/) documentation. Check there for current figures.

## Operate

### Update

```sh
git pull
npm ci
npm run db:migrate:remote
npm run deploy
```

Run the migration first. This needs an API token in `.local/cloudflare.env`.

### Back up

Posts exist only in D1, and deleting one is permanent. D1 Time Travel keeps 7 days of history on the Free plan and 30 on paid plans. To export a copy:

```sh
node --env-file=.local/cloudflare.env node_modules/wrangler/bin/wrangler.js d1 export DB \
  --remote --output .local/backup.sql --config .local/wrangler.deploy.jsonc
```

### Look after `.local/`

| File | Contains | If you lose it |
| --- | --- | --- |
| `site.json` | Your blog's settings | Recreate it from `site.example.json`. |
| `cloudflare.env` | Your API token | Create a new token. |
| `mcp.env` | Your publishing credential | Run `npm run cloudflare:rotate`. |
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

Minimalism is the point. noax has no dashboard, drafts, comments, images, tags, search, multiple authors or client-side JavaScript, and it isn't likely to gain them. Bug fixes and changes that make it smaller or easier to run are very welcome. Please open an issue before starting anything larger.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE)
