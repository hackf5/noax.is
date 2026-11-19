export const FILE_ID = /^[0-9a-f]{64}$/;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const IMAGE_HEADER_BYTES = 256 * 1024;
export const IMAGE_LIMITS = "PNG, JPEG or WebP, up to 8 MiB, 4,096 pixels per axis and 12 megapixels";

export interface ImageInfo {
  content_type: typeof IMAGE_TYPES[number];
  width: number;
  height: number;
}

function dimensions(content_type: ImageInfo["content_type"], width: number, height: number): ImageInfo | undefined {
  if (width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 12_000_000) {
    return { content_type, width, height };
  }
}

function jpeg(view: DataView): ImageInfo | undefined {
  // Skip whole marker segments so EXIF thumbnails never supply the dimensions of the main image.
  for (let offset = 2; offset + 8 <= view.byteLength;) {
    if (view.getUint8(offset++) !== 0xff) return;
    const marker = view.getUint8(offset++);
    if (marker === 0xff) { offset--; continue; }
    if (marker === 0xda || marker === 0xd9 || marker === 0) return;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > view.byteLength) return;
    // The SOF family excludes Huffman tables, the reserved JPG marker and arithmetic tables.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length >= 8) return dimensions("image/jpeg", view.getUint16(offset + 5), view.getUint16(offset + 3));
      return;
    }
    offset += length;
  }
}

function webp(view: DataView, size: number): ImageInfo | undefined {
  if (view.getUint32(4, true) + 8 !== size) return;
  const chunkLength = view.getUint32(16, true);
  if (chunkLength + 20 > size) return;
  const chunk = view.getUint32(12);
  if (chunk === 0x56503858 && chunkLength === 10 && view.byteLength >= 30) { // VP8X
    const width = view.getUint32(23, true) & 0xffffff;
    const height = view.getUint8(26) | view.getUint16(27, true) << 8;
    return dimensions("image/webp", width + 1, height + 1);
  }
  if (chunk === 0x5650384c && chunkLength >= 5 && view.getUint8(20) === 0x2f) { // VP8L
    const bits = view.getUint32(21, true);
    return dimensions("image/webp", (bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1);
  }
  if (chunk === 0x56503820 && chunkLength >= 10 && view.byteLength >= 30 && // VP8
      view.getUint8(23) === 0x9d && view.getUint16(24) === 0x012a) {
    return dimensions("image/webp", view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  }
}

export function imageInfo(bytes: Uint8Array, size: number): ImageInfo | undefined {
  if (bytes.length < 25) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a &&
      view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452 && size >= 33) {
    return dimensions("image/png", view.getUint32(16), view.getUint32(20));
  }
  if (view.getUint16(0) === 0xffd8) return jpeg(view);
  if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) return webp(view, size);
}
