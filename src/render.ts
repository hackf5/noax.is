import MarkdownIt from "markdown-it";
import type { Rendered } from "./types";

// Stored posts are a cache of this output. Bump this whenever renderMarkdown's output changes,
// and posts rebuild as they're read.
export const RENDER_VERSION = 1;

const TITLE_LENGTH = 70;
const SUMMARY_LENGTH = 160;

const markdown = new MarkdownIt("commonmark", { html: false }).disable("image");
type Token = ReturnType<typeof markdown.parse>[number];

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

function plainText(inline: Token): string {
  return (inline.children ?? []).map((token) => {
    if (token.type === "text" || token.type === "code_inline") return token.content;
    return token.type === "softbreak" || token.type === "hardbreak" ? "\n" : "";
  }).join("");
}

function truncate(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > limit / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

export function renderMarkdown(source: string): Rendered {
  const tokens = markdown.parse(source, {});
  const blocks = tokens.filter((token) => token.type === "inline").map(plainText).filter((text) => text.trim());
  const first = blocks[0] ?? "";
  const body = tokens[0]?.type === "heading_open" ? blocks.slice(1) : blocks;
  const title = truncate(first.split("\n")[0]!, TITLE_LENGTH) || "Post";
  return {
    html: markdown.renderer.render(tokens, markdown.options, {}),
    title,
    summary: truncate(body.join(" "), SUMMARY_LENGTH) || title,
  };
}
