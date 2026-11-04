import MarkdownIt from "markdown-it";
import type { Post, PostPage } from "./types";

const markdown = new MarkdownIt("commonmark", { html: false }).disable("image");
const defaultFence = markdown.renderer.rules.fence!;
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) =>
  defaultFence(tokens, index, options, env, renderer).replace("<pre>", '<pre tabindex="0">');
for (const rule of ["heading_open", "heading_close"] as const) {
  markdown.renderer.rules[rule] = (tokens, index) => {
    const token = tokens[index]!;
    const level = Math.min(Number(token.tag.slice(1)) + 1, 6);
    return rule === "heading_open" ? `<h${level}>` : `</h${level}>\n`;
  };
}
const defaultCodeBlock = markdown.renderer.rules.code_block!;
markdown.renderer.rules.code_block = (tokens, index, options, env, renderer) =>
  defaultCodeBlock(tokens, index, options, env, renderer).replace("<pre>", '<pre tabindex="0">');

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

function layout(content: string, title = "noax.is", description = "Notes on noax.is"): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="text-scale" content="scale"><meta name="description" content="${escapeHtml(description)}"><title>${escapeHtml(title)}</title><link rel="icon" href="/favicon.ico" type="image/vnd.microsoft.icon" sizes="16x16 32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any"><link rel="stylesheet" href="/style.css"></head>
<body><div class="page"><header><h1><a href="/">noax.is</a></h1></header><main>${content}</main></div></body></html>`;
}

function renderPost(post: Post): string {
  const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(post.created_at));
  return `<article><a href="/posts/${post.id}"><time datetime="${escapeHtml(post.created_at)}">${escapeHtml(date)} UTC</time></a><div class="body">${markdown.render(post.markdown)}</div></article>`;
}

export function timeline(page: PostPage): string {
  const posts = page.posts.map(renderPost).join("") || '<p class="quiet">No posts yet.</p>';
  const navigation = page.next_cursor
    ? `<nav aria-label="Pagination"><a href="/?before=${encodeURIComponent(page.next_cursor)}">Older posts</a></nav>`
    : "";
  return layout(posts + navigation);
}

export function postPage(post: Post): string {
  return layout(`${renderPost(post)}<nav><a href="/">All posts</a></nav>`, "Post · noax.is");
}

export function errorPage(message: string): string {
  return layout(`<p>${escapeHtml(message)}</p><p><a href="/">All posts</a></p>`, `${message} · noax.is`);
}
