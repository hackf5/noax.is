import { xml } from "./feed";
import type { Site } from "./html";
import { plainMarkdown } from "./markdown";
import { postPath } from "./post-metadata";
import type { PublishedPost, SitemapBucket, SitemapPost } from "./types";

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
const SITEMAP_NAMESPACE = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';

export function robotsTxt(site: Site): string {
  return `User-agent: *\nContent-Signal: ${site.contentSignal}\nAllow: /\n\nSitemap: ${site.origin}/sitemap.xml\n`;
}

export function llmsTxt(site: Site, posts: PublishedPost[]): string {
  const recent = posts.map((post) => `- [${plainMarkdown(post.title)}](${site.origin}${postPath(post)}.md): ${plainMarkdown(post.summary)}`);
  return `# ${plainMarkdown(site.title)}

> ${plainMarkdown(site.description)}

This is a single-author Markdown blog. Every page is available as Markdown, which is the post as the author wrote it.

- To get Markdown, send \`Accept: text/markdown\` to any page, or add \`.md\` to a post's URL. The timeline is at [index.md](${site.origin}/index.md).
- To reach older posts, follow the "Older posts" link at the end of each timeline page, or use the sitemap.
- Each post's front matter gives its title, description, URL and dates. Times are UTC.
- Posts can be edited after publication, so \`updated\` can differ from \`published\`.
- When citing a post, link to the \`url\` in its front matter, not the \`.md\` address.
- The public site is read-only, and has no API for writing or searching.
${recent.length ? `\n## Recent posts\n\n${recent.join("\n")}\n` : ""}
## Optional

- [Atom feed](${site.origin}/feed.xml): The newest posts as rendered HTML.
- [Sitemap](${site.origin}/sitemap.xml): Every post, with the time it last changed.
`;
}

function entry(tag: "sitemap" | "url", location: string, lastmod?: string): string {
  return `<${tag}><loc>${xml(location)}</loc>${lastmod ? `<lastmod>${xml(lastmod)}</lastmod>` : ""}</${tag}>`;
}

function urlset(entries: string[]): string {
  return `${XML_DECLARATION}<urlset ${SITEMAP_NAMESPACE}>${entries.join("")}</urlset>`;
}

// Always lists the pages sitemap, so the index stays valid on a site with no posts.
export function sitemapIndex(site: Site, buckets: SitemapBucket[]): string {
  const entries = [
    entry("sitemap", `${site.origin}/sitemap-pages.xml`),
    ...buckets.map(({ bucket, lastmod }) => entry("sitemap", `${site.origin}/sitemap-posts-${bucket}.xml`, lastmod)),
  ];
  return `${XML_DECLARATION}<sitemapindex ${SITEMAP_NAMESPACE}>${entries.join("")}</sitemapindex>`;
}

export function pagesSitemap(site: Site): string {
  return urlset([entry("url", `${site.origin}/`)]);
}

export function postsSitemap(site: Site, posts: SitemapPost[]): string {
  return urlset(posts.map((post) => entry("url", `${site.origin}${postPath(post)}`, post.updated_at)));
}
