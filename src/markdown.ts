import type { Site } from "./html";
import type { PostPage, PublishedPost } from "./types";

export type TextType = "text/markdown" | "text/plain";

const SEPARATOR = "\n\n---\n\n";

// Browsers never name text/markdown, so naming it is deliberate and wins a tie with HTML. Generic
// clients send text/plain by default, so that only counts if it beats HTML outright.
export function preferredText(accept: string | null): TextType | null {
  const ranges = new Map<string, number>();
  for (const part of (accept ?? "").split(",")) {
    const [range, ...parameters] = part.split(";").map((value) => value.trim().toLowerCase());
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    ranges.set(range!, quality ? Number(quality.slice(2)) : 1);
  }
  const html = ranges.get("text/html") ?? ranges.get("text/*") ?? ranges.get("*/*") ?? 0;
  const markdown = ranges.get("text/markdown") ?? 0;
  if (markdown > 0 && markdown >= html) return "text/markdown";
  return (ranges.get("text/plain") ?? 0) > html ? "text/plain" : null;
}

// For plain text placed inside Markdown. A title can hold a literal [x](javascript:...) that the
// renderer refused as a link, which must not come back to life here.
export function plainMarkdown(value: string): string {
  return value.replace(/[\\[\]<]/g, "\\$&");
}

export function markdownPost(site: Site, post: PublishedPost): string {
  // JSON strings are valid YAML, so quotes and newlines in a title can't break the front matter.
  const fields = Object.entries({
    title: post.title,
    description: post.summary,
    url: `${site.origin}/posts/${post.id}`,
    published: post.created_at,
    updated: post.updated_at,
  }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${fields.join("\n")}\n---\n\n${post.markdown}\n`;
}

export function markdownTimeline(site: Site, page: PostPage): string {
  const heading = `# ${plainMarkdown(site.title)}\n\n${plainMarkdown(site.description)}\n\nGuide for agents: [llms.txt](${site.origin}/llms.txt)`;
  const posts = page.posts.map((post) => `[${post.created_at}](${site.origin}/posts/${post.id})\n\n${post.markdown}`);
  const older = page.next_cursor ? [`[Older posts](${site.origin}/index.md?before=${encodeURIComponent(page.next_cursor)})`] : [];
  return `${[heading, ...(posts.length ? posts : ["No posts yet."]), ...older].join(SEPARATOR)}\n`;
}

export function markdownError(site: Site, message: string): string {
  return `# ${message}\n\n[All posts](${site.origin}/index.md)\n`;
}
