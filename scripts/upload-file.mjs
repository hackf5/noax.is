import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { IMAGE_HEADER_BYTES, IMAGE_LIMITS, MAX_FILE_BYTES, imageInfo } from "../src/files/image.ts";
import { getMcpHeaders, getMcpUrl, sameOriginFetch } from "./mcp-headers.mjs";

async function readBytes(stream) {
  const parts = [];
  let size = 0;
  for await (const part of stream) {
    size += part.length;
    if (size > MAX_FILE_BYTES) throw new Error("Images must be at most 8 MiB.");
    parts.push(part);
  }
  return Buffer.concat(parts, size);
}

async function localImage(path) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Supply a regular image file of at most 8 MiB.");
    return { bytes: await readBytes(file.createReadStream({ autoClose: false })), filename: basename(path) };
  } finally {
    await file.close();
  }
}

async function linkedImage(value) {
  const signal = AbortSignal.timeout(30_000);
  let url = new URL(value);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Use a direct HTTPS image URL.");
    const response = await fetch(url, { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has("Location")) {
      await response.body?.cancel();
      url = new URL(response.headers.get("Location"), url);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Could not download the image (HTTP ${response.status}).`);
    if (Number(response.headers.get("Content-Length")) > MAX_FILE_BYTES) {
      await response.body.cancel();
      throw new Error("Images must be at most 8 MiB.");
    }
    return { bytes: await readBytes(response.body), filename: basename(url.pathname) };
  }
  throw new Error("The image URL redirected too many times.");
}

const client = new Client({ name: "noax-file-upload", version: "0.1.0" });
let headers;
try {
  const { values: { path, url } } = parseArgs({ options: { path: { type: "string" }, url: { type: "string" } } });
  if (Boolean(path) === Boolean(url)) throw new Error("Use npm run files:upload -- --path <file> or --url <https-image-url>.");
  const { bytes, filename } = path ? await localImage(path) : await linkedImage(url);
  const image = imageInfo(bytes.subarray(0, IMAGE_HEADER_BYTES), bytes.length);
  if (!image) throw new Error(`Accepted images are ${IMAGE_LIMITS}.`);
  const id = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    id,
    filename: filename.replace(/[\\/\x00-\x1f\x7f]/g, "_").trim().slice(0, 255) || "image",
    content_type: image.content_type,
    byte_size: bytes.length,
  };

  const mcp = await getMcpUrl();
  if (mcp.protocol !== "https:" || mcp.pathname !== "/mcp" || mcp.username || mcp.password || mcp.search || mcp.hash) {
    throw new Error("NOAX_MCP_URL must be the HTTPS /mcp endpoint for this blog.");
  }
  headers = await getMcpHeaders();
  const fetchMcp = sameOriginFetch(mcp.origin);
  await client.connect(new StreamableHTTPClientTransport(mcp, { requestInit: { headers }, fetch: fetchMcp }));
  const reservation = await client.callTool({ name: "begin_file_upload", arguments: manifest });
  if (reservation.isError) throw new Error(reservation.structuredContent?.error?.message ?? "The server did not reserve this file.");
  let { file, upload_url: uploadUrl } = reservation.structuredContent ?? {};
  if (file?.id !== id) throw new Error("The server returned a different file ID.");

  if (uploadUrl) {
    const target = new URL(uploadUrl);
    if (target.pathname !== `/mcp/uploads/${id}/${file.version}` || target.search || target.hash) {
      throw new Error("The server returned an unexpected upload URL.");
    }
    const response = await fetchMcp(target, {
      method: "PUT",
      headers: { ...headers, "Content-Type": image.content_type, "Content-Length": String(bytes.length) },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error?.message ?? `The upload returned HTTP ${response.status}.`);
    file = result.file;
  }
  if (file?.id !== id || file.state !== "ready" || !file.url) throw new Error("The file is not ready. Check the reservation before publishing.");
  console.log(JSON.stringify(file, null, 2));
} catch (error) {
  let message = error.message;
  for (const value of Object.values(headers ?? {})) message = message.replaceAll(value, "[redacted]");
  console.error(`Noax file upload failed: ${message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
