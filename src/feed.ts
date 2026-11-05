import { escapeHtml, type Site } from "./html";
import type { PublishedPost } from "./types";

// XML 1.0 forbids these characters even when escaped, and one would break the whole feed.
export function xml(value: string): string {
  return escapeHtml(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, ""));
}

export function atomFeed(site: Site, posts: PublishedPost[]): string {
  const updated = posts.map((post) => post.updated_at).sort().at(-1) ?? "1970-01-01T00:00:00.000Z";
  const entries = posts.map((post) => {
    const url = `${site.origin}/posts/${post.id}`;
    return `<entry><id>urn:uuid:${post.id}</id><title>${xml(post.title)}</title><link rel="alternate" type="text/html" href="${xml(url)}"/><published>${xml(post.created_at)}</published><updated>${xml(post.updated_at)}</updated><summary>${xml(post.summary)}</summary><content type="html">${xml(post.html)}</content></entry>`;
  }).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><id>${xml(site.origin)}/</id><title>${xml(site.title)}</title><subtitle>${xml(site.description)}</subtitle><link rel="self" type="application/atom+xml" href="${xml(site.origin)}/feed.xml"/><link rel="alternate" type="text/html" href="${xml(site.origin)}/"/><updated>${xml(updated)}</updated><author><name>${xml(site.title)}</name></author>${entries}</feed>`;
}
