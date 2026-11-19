import { PostError, type Env } from "../types";
import { FILE_ID, IMAGE_HEADER_BYTES, IMAGE_LIMITS, imageInfo, type ImageInfo } from "./image";

export const IMMUTABLE_FILE = "public, max-age=31536000, immutable";
const NOT_READY = "Referenced file is no longer ready";
const FILE_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\/([0-9a-f]{64})$/;

export interface FileInput {
  id: string;
  filename: string;
  content_type: ImageInfo["content_type"];
  byte_size: number;
}

interface StoredFile extends FileInput {
  width: number | null;
  height: number | null;
  state: "pending" | "uploading" | "ready" | "deleting";
  version: string;
  created_at: string;
  ready_at: string | null;
}

class IncompleteBody extends Error {}

export interface FileImage {
  id: string;
  width: number;
  height: number;
}

async function readImageHeader(stream: ReadableStream<Uint8Array>, size: number): Promise<ImageInfo | undefined> {
  const reader = stream.getReader();
  const bytes = new Uint8Array(Math.min(size, IMAGE_HEADER_BYTES));
  let length = 0;
  try {
    while (length < bytes.length) {
      const { done, value } = await reader.read();
      if (done) throw new PostError("validation", "The upload did not deliver its declared Content-Length.");
      const header = value.subarray(0, bytes.length - length);
      bytes.set(header, length);
      length += header.length;
    }
    return imageInfo(bytes, size);
  } finally {
    // Cancelling one tee branch only settles after the other branch has finished too.
    void reader.cancel().catch(() => {});
  }
}

async function transferImage(body: ReadableStream<Uint8Array>, output: WritableStream, size: number): Promise<void> {
  const reader = body.getReader();
  const writer = output.getWriter();
  let written = 0;
  try {
    for (;;) {
      const chunk = await reader.read().catch((error: unknown) => {
        if (written < size) throw new IncompleteBody("Image transfer stopped early", { cause: error });
        throw error;
      });
      if (chunk.done) break;
      if (written + chunk.value.length > size) {
        if (written < size) throw new IncompleteBody("Image transfer exceeded Content-Length");
        throw new Error("Unexpected bytes after Content-Length");
      }
      await writer.write(chunk.value);
      written += chunk.value.length;
    }
    if (written !== size) throw new IncompleteBody("Image transfer stopped early");
    await writer.close();
  } catch (error) {
    void reader.cancel().catch(() => {});
    await writer.abort(error).catch(() => {});
    throw error;
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

function sameBytes(object: R2Object, file: StoredFile): boolean {
  const sha256 = object.checksums.sha256;
  return object.size === file.byte_size && sha256 !== undefined &&
    Array.from(new Uint8Array(sha256), (byte) => byte.toString(16).padStart(2, "0")).join("") === file.id;
}

export function filesFrom(env: Env): Files | undefined {
  if (env.FILES && env.MEDIA_HOST && /^[a-z0-9.-]+$/.test(env.MEDIA_HOST)) {
    return new Files(env.DB, env.FILES, `https://${env.MEDIA_HOST}`);
  }
}

export class Files {
  constructor(private readonly db: D1Database, private readonly bucket: R2Bucket, public readonly origin: string) {}

  private present(file: StoredFile) {
    return { ...file, url: file.state === "ready" ? `${this.origin}/${file.id}` : null };
  }

  private async stored(id: string): Promise<StoredFile> {
    const file = await this.db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<StoredFile>();
    if (!file) throw new PostError("not_found", "File not found.");
    return file;
  }

  async get(id: string) {
    return this.present(await this.stored(id));
  }

  async list(cursor: string | undefined, limit: number, unusedOnly: boolean) {
    const before = cursor ? FILE_CURSOR.exec(cursor) : null;
    if (cursor && !before) throw new PostError("validation", "Invalid file page cursor. Use next_cursor from list_files.");
    const filters = [
      before ? "(created_at, id) < (?, ?)" : "",
      unusedOnly ? "NOT EXISTS (SELECT 1 FROM post_files WHERE file_id = files.id)" : "",
    ].filter(Boolean).join(" AND ");
    const { results } = await this.db.prepare(
      `SELECT * FROM files ${filters ? `WHERE ${filters}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(...(before ? [before[1], before[2]] : []), limit + 1).all<StoredFile>();
    const files = results.slice(0, limit);
    const last = files.at(-1);
    return {
      files: files.map((file) => this.present(file)),
      next_cursor: results.length > limit && last ? `${last.created_at}/${last.id}` : null,
    };
  }

  async begin(input: FileInput, mcpHost: string) {
    const filename = input.filename.trim();
    if (!filename || /[\\/\x00-\x1f\x7f]/.test(filename)) throw new PostError("validation", "Supply a plain filename.");
    await this.db.prepare(
      `INSERT INTO files (id, version, filename, content_type, byte_size, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT (id) DO NOTHING`,
    ).bind(input.id, crypto.randomUUID(), filename, input.content_type, input.byte_size, new Date().toISOString()).run();
    let file = await this.stored(input.id);
    if (file.state === "deleting") throw new PostError("conflict", "This checksum is being deleted. Check the file before retrying.");
    if (file.content_type !== input.content_type || file.byte_size !== input.byte_size) {
      throw new PostError("validation", "The existing reservation for this checksum has different image metadata.");
    }
    if (file.state === "uploading") file = await this.recoverUpload(file);
    return {
      file: this.present(file),
      upload_url: file.state === "pending" ? `https://${mcpHost}/mcp/uploads/${file.id}/${file.version}` : null,
    };
  }

  private async markReady(file: StoredFile): Promise<StoredFile> {
    const ready = await this.db.prepare(
      "UPDATE files SET state = 'ready', ready_at = ? WHERE id = ? AND version = ? AND state = 'uploading' RETURNING *",
    ).bind(new Date().toISOString(), file.id, file.version).first<StoredFile>();
    if (ready) return ready;
    const current = await this.stored(file.id);
    if (current.version === file.version && current.state === "ready") return current;
    throw new PostError("conflict", "The upload reservation has changed.");
  }

  private async recoverUpload(file: StoredFile): Promise<StoredFile> {
    const object = await this.bucket.head(file.id);
    if (object && sameBytes(object, file)) return this.markReady(file);
    // Absence alone cannot rule out a previous in-flight R2 write.
    throw new PostError("conflict", "Upload is pending in R2. Retry the reservation to check for a completed write.");
  }

  async upload(id: string, version: string, request: Request) {
    let file = await this.stored(id);
    if (file.version !== version || file.state === "deleting") throw new PostError("conflict", "This upload reservation has changed.");
    if (file.state === "uploading") file = await this.recoverUpload(file);
    if (file.state === "ready") return this.present(file);
    if (!request.body || request.headers.get("Content-Length") !== String(file.byte_size) ||
        request.headers.get("Content-Type") !== file.content_type || request.headers.has("Content-Encoding")) {
      throw new PostError("validation", "Send the reserved Content-Type and Content-Length with the original bytes.");
    }

    const [probe, body] = request.body.tee();
    let claimed: StoredFile | null;
    try {
      const image = await readImageHeader(probe, file.byte_size);
      if (!image || image.content_type !== file.content_type) {
        throw new PostError("validation", `Use a matching image header and dimensions. Accepted images are ${IMAGE_LIMITS}.`);
      }
      claimed = await this.db.prepare(
        "UPDATE files SET state = 'uploading', width = ?, height = ? WHERE id = ? AND version = ? AND state = 'pending' RETURNING *",
      ).bind(image.width, image.height, id, version).first<StoredFile>();
      if (!claimed) throw new PostError("conflict", "The upload reservation has changed. Call begin_file_upload again.");
    } catch (error) {
      void body.cancel().catch(() => {});
      throw error;
    }

    const stream = new FixedLengthStream(file.byte_size);
    const [write, transfer] = await Promise.allSettled([
      this.bucket.put(id, stream.readable, {
        sha256: id,
        onlyIf: new Headers({ "If-None-Match": "*" }),
        httpMetadata: { contentType: file.content_type, cacheControl: IMMUTABLE_FILE },
      }),
      transferImage(body, stream.writable, file.byte_size),
    ]);
    if (write.status === "fulfilled" && write.value) return this.present(await this.markReady(claimed));
    if (write.status === "fulfilled") return this.present(await this.recoverUpload(claimed));
    const error = write.reason;
    // R2's checksum rejection and a stream that could not deliver its declared length cannot commit.
    const incomplete = transfer.status === "rejected" && transfer.reason instanceof IncompleteBody;
    const wrongDigest = error instanceof Error && /(?:sha-?256|checksum).*(?:did not match|mismatch|not match)|bad.?digest/i.test(error.message);
    if (incomplete || wrongDigest) {
      await this.db.prepare("UPDATE files SET state = 'pending', width = NULL, height = NULL WHERE id = ? AND version = ? AND state = 'uploading'")
        .bind(id, version).run();
      throw new PostError("validation", incomplete ? "The upload did not deliver its declared Content-Length." : "The bytes do not match the reserved SHA-256 checksum.");
    }
    return this.present(await this.recoverUpload(claimed));
  }

  async delete(id: string, version: string): Promise<void> {
    // A reservation in pending has never committed any bytes. Its CAS also excludes an upload claim.
    const pending = await this.db.prepare("DELETE FROM files WHERE id = ? AND version = ? AND state = 'pending' RETURNING id")
      .bind(id, version).first();
    if (pending) return;
    const claimed = await this.db.prepare(
      `UPDATE files SET state = 'deleting' WHERE id = ? AND version = ? AND state = 'ready'
       AND NOT EXISTS (SELECT 1 FROM post_files WHERE file_id = files.id) RETURNING id`,
    ).bind(id, version).first();
    if (claimed) {
      await this.bucket.delete(id);
    } else {
      const file = await this.stored(id);
      if (file.version !== version) throw new PostError("conflict", "File changed. Review get_file before deleting.");
      if (file.state !== "deleting" || await this.bucket.head(id)) {
        throw new PostError("conflict", "The file is referenced or still has a storage operation in progress.");
      }
      // A deleting row came from ready, so absence confirms the object was removed. A retry
      // finalizes metadata without issuing a second delete against the reusable checksum key.
    }
    await this.db.prepare("DELETE FROM files WHERE id = ? AND version = ? AND state = 'deleting'").bind(id, version).run();
  }

  async ready(ids: string[]): Promise<Map<string, FileImage>> {
    if (!ids.length) return new Map();
    const { results } = await this.db.prepare(
      `SELECT id, width, height FROM files WHERE state = 'ready' AND id IN (${ids.map(() => "?").join(", ")})`,
    ).bind(...ids).all<FileImage>();
    const images = new Map(results.map((file) => [file.id, file]));
    const missing = ids.find((id) => !images.has(id));
    if (missing) throw new PostError("validation", `File ${missing} is missing or not ready.`);
    return images;
  }

  async attached(postId: string): Promise<Map<string, FileImage>> {
    const { results } = await this.db.prepare(
      "SELECT files.id, width, height FROM post_files JOIN files ON files.id = file_id WHERE post_id = ? AND files.state = 'ready'",
    ).bind(postId).all<FileImage>();
    return new Map(results.map((file) => [file.id, file]));
  }
}

export async function fileBatch<T>(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
  try {
    return await db.batch<T>(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes(NOT_READY)) {
      throw new PostError("validation", `${NOT_READY}.`);
    }
    throw error;
  }
}

export const uploadPath = new RegExp(`^/mcp/uploads/(${FILE_ID.source.slice(1, -1)})/([0-9a-f-]{36})$`);
