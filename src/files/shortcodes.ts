import type MarkdownIt from "markdown-it";
import { PostError } from "../types";
import type { FileImage } from "./store";

const NAME = "noax_file";
const MAX_BLOCKS = 12;
const SHORTCODE = /^\{%[ \t]+file[ \t]+([0-9a-f]{64})[ \t]*\|[ \t]*(image|ascii[ \t]+(?:bw|color))[ \t]*\|[ \t]*alt[ \t]+(".*")[ \t]*%\}[ \t]*$/;

interface FileBlock {
  id: string;
  ascii?: "bw" | "color";
  alt: string;
}

type Parser = InstanceType<typeof MarkdownIt>;
type Token = ReturnType<Parser["parse"]>[number];

function parseBlock(line: string): FileBlock | undefined {
  const match = line.length <= 1200 ? SHORTCODE.exec(line) : null;
  if (!match) return;
  try {
    const alt: unknown = JSON.parse(match[3]!);
    if (typeof alt !== "string" || alt.length > 300 || /[\x00-\x1f\x7f]/.test(alt)) return;
    const mode = match[2]!;
    return { id: match[1]!, ascii: mode === "image" ? undefined : mode.endsWith("bw") ? "bw" : "color", alt };
  } catch {
    return;
  }
}

export function registerFileShortcodes(markdown: Parser): void {
  markdown.block.ruler.before("paragraph", NAME, (state, line, _end, silent) => {
    if (!state.env.fileBlocks || state.level !== 0 || state.sCount[line]! >= 4) return false;
    const source = state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]!);
    if (!/^\{%[ \t]*file\b/.test(source)) return false;
    if (silent) return true;
    const token = state.push(NAME, "img", 0);
    token.block = true;
    token.map = [line, line + 1];
    token.content = source;
    token.meta = { file: parseBlock(source) };
    state.line = line + 1;
    return true;
  });

  markdown.renderer.rules[NAME] = (tokens, index, _options, env) => {
    const token = tokens[index]!;
    const file = token.meta?.file as FileBlock | undefined;
    const images = env?.images as Map<string, FileImage> | undefined;
    const image = file && images?.get(file.id);
    const origin = env?.mediaOrigin;
    const escape = markdown.utils.escapeHtml;
    if (!file || !image || typeof origin !== "string") return `<p>${escape(token.content)}</p>\n`;
    const ascii = file.ascii ? ` data-noax-ascii="${file.ascii}"` : "";
    return `<img class="file-image"${ascii} src="${escape(`${origin}/${file.id}`)}" alt="${escape(file.alt)}" width="${image.width}" height="${image.height}" loading="lazy" decoding="async" crossorigin="anonymous">\n`;
  };
}

export function fileIds(tokens: Token[]): string[] {
  const blocks = tokens.filter((token) => token.type === NAME);
  if (blocks.length > MAX_BLOCKS) throw new PostError("validation", `Use at most ${MAX_BLOCKS} file blocks per post.`);
  const ids = new Set<string>();
  for (const block of blocks) {
    const file = block.meta?.file as FileBlock | undefined;
    if (!file) throw new PostError("validation", `Invalid file shortcode on line ${block.map![0] + 1}. Use {% file <sha256> | image | alt "Description" %}.`);
    ids.add(file.id);
  }
  return [...ids];
}
