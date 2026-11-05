import { createHash } from "node:crypto";
import type { Env, PostPage, PublishedPost } from "./types";
import { postPath } from "./post-metadata";

export interface Site {
  title: string;
  description: string;
  locale: string;
  origin: string;
  contentSignal: string;
}

export function siteFrom(env: Env): Site {
  return {
    title: env.SITE_TITLE,
    description: env.SITE_DESCRIPTION,
    locale: env.SITE_LOCALE,
    origin: `https://${env.PUBLIC_HOST}`,
    contentSignal: env.SITE_CONTENT_SIGNAL,
  };
}

interface PageMeta {
  title?: string;
  description?: string;
  canonical?: string;
  published?: string;
  markdown?: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export const stylesheet = `
:root { color-scheme: light dark; --paper: #ffffff; --ink: #202c39; --muted: #536577; --line: #dce3e9; --link: #245c91; }
@media (prefers-color-scheme: dark) { :root { --paper: #18212a; --ink: #e3eaf0; --muted: #a6b7c7; --line: #3a4b5a; --link: #9ac8ef; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: system-ui, sans-serif; line-height: 1.65; }
.page { max-width: 42rem; margin-inline: auto; padding: 3rem 1.25rem; }
header { margin-block-end: 3rem; }
h1 { margin: 0; font-family: ui-monospace, monospace; font-size: 1.3rem; font-weight: 600; letter-spacing: -.055em; }
h1 a { color: inherit; text-decoration: none; }
a { color: var(--link); text-underline-offset: .2em; }
a:focus-visible, pre:focus-visible { outline: 2px solid var(--link); outline-offset: 4px; }
article { padding-block: 1.8rem; border-block-start: 1px solid var(--line); }
article > a { color: var(--muted); font-family: ui-monospace, monospace; font-size: .8rem; }
.body { margin-block-start: .8rem; overflow-wrap: anywhere; }
.body > :first-child { margin-block-start: 0; }
.body > :last-child { margin-block-end: 0; }
.body h1, .body h2, .body h3, .body h4, .body h5, .body h6 { font-family: inherit; font-size: 1.1rem; letter-spacing: normal; line-height: 1.4; }
blockquote { margin-inline: 0; padding-inline-start: 1rem; border-inline-start: 2px solid var(--line); color: var(--muted); }
pre { max-width: 100%; overflow-x: auto; padding: 1rem; border: 1px solid var(--line); border-radius: .25rem; }
code { font-family: ui-monospace, monospace; font-size: .9em; }
nav { margin-block-start: 2rem; }
.quiet { color: var(--muted); }
`;

// Changes with the stylesheet, so browsers can keep each version for good and still get new ones.
export const stylesheetVersion = createHash("sha256").update(stylesheet).digest("hex").slice(0, 12);

function ogTag(property: string, content: string): string {
  return `<meta property="${property}" content="${escapeHtml(content)}">`;
}

function layout(site: Site, content: string, meta: PageMeta = {}): string {
  const title = meta.title ? `${meta.title} · ${site.title}` : site.title;
  const description = meta.description ?? site.description;
  const social = meta.canonical
    ? `<link rel="canonical" href="${escapeHtml(meta.canonical)}">${[
        ogTag("og:title", meta.title ?? site.title),
        ogTag("og:description", description),
        ogTag("og:type", meta.published ? "article" : "website"),
        ogTag("og:url", meta.canonical),
        ogTag("og:site_name", site.title),
        ...(meta.published ? [ogTag("article:published_time", meta.published)] : []),
      ].join("")}`
    : "";
  const markdown = meta.markdown ? `<link rel="alternate" type="text/markdown" href="${escapeHtml(meta.markdown)}">` : "";
  return `<!doctype html>
<html lang="${escapeHtml(site.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="text-scale" content="scale"><meta name="description" content="${escapeHtml(description)}"><title>${escapeHtml(title)}</title>${social}<link rel="alternate" type="application/atom+xml" title="${escapeHtml(site.title)}" href="/feed.xml">${markdown}<link rel="icon" href="/favicon.ico" type="image/vnd.microsoft.icon" sizes="16x16 32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any"><link rel="stylesheet" href="/style.css?v=${stylesheetVersion}"></head>
<body><div class="page"><header><h1><a href="/">${escapeHtml(site.title)}</a></h1></header><main>${content}</main></div></body></html>`;
}

function dateFormat(site: Site): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(site.locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
}

// The renderer marks the title once, so cached reads never parse Markdown again.
export function postBody(post: PublishedPost, linkTitle = false): string {
  return post.html.replace(/<!--post-title--><h2>([\s\S]*?)<\/h2>/, (_match, title: string) =>
    linkTitle
      ? `<h2><a href="${escapeHtml(postPath(post))}">${title.replace(/<\/?a\b[^>]*>/g, "")}</a></h2>`
      : `<h2>${title}</h2>`);
}

function renderPost(post: PublishedPost, dates: Intl.DateTimeFormat, linkTitle = false): string {
  const date = dates.format(new Date(post.created_at));
  return `<article><a href="${escapeHtml(postPath(post))}"><time datetime="${escapeHtml(post.created_at)}">${escapeHtml(date)} UTC</time></a><div class="body">${postBody(post, linkTitle)}</div></article>`;
}

export function timeline(site: Site, page: PostPage<PublishedPost>, firstPage: boolean, markdown: string): string {
  const dates = dateFormat(site);
  const posts = page.posts.map((post) => renderPost(post, dates, true)).join("") || '<p class="quiet">No posts yet.</p>';
  const navigation = page.next_cursor
    ? `<nav aria-label="Pagination"><a href="/?before=${encodeURIComponent(page.next_cursor)}">Older posts</a></nav>`
    : "";
  return layout(site, posts + navigation, firstPage ? { canonical: `${site.origin}/`, markdown } : { markdown });
}

export function postPage(site: Site, post: PublishedPost): string {
  return layout(site, `${renderPost(post, dateFormat(site))}<nav><a href="/">All posts</a></nav>`, {
    title: post.title,
    description: post.summary,
    canonical: `${site.origin}${postPath(post)}`,
    published: post.created_at,
    markdown: `${postPath(post)}.md`,
  });
}

export function errorPage(site: Site, message: string): string {
  return layout(site, `<p>${escapeHtml(message)}</p><p><a href="/">All posts</a></p>`, { title: message });
}
