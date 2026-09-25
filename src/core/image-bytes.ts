// @generated — DO NOT EDIT.
//
// Vendored copy of packages/core/src/image-bytes.ts, emitted by
// `pnpm --filter @kinjot/core emit:mcp-core` (plans/desktop-app.md §4.5).
// Edit the source module and re-run; CI fails on any difference.

/**
 * The largest stripped image the agent path uploads, and the largest web PNG
 * stored where a JPEG would do. Amazon Bedrock and Google Cloud
 * take at most 5 MB of base64 per image (about 3.75 MB of bytes), the smallest
 * ceiling among Claude's platforms, so a PNG past this is one some agent cannot
 * read. The web can keep a larger transparent PNG because JPEG has no alpha;
 * the agent path refuses any output over this limit. The store's 25 MiB
 * object ceiling still bounds transparent web uploads.
 */
export const MAX_LOSSLESS_BYTES = 3.5 * 1024 * 1024;

export const PNG_SIGNATURE: readonly number[] = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * The chunks a PNG kept as its own bytes still carries: the image itself and
 * what colour-manages or scales it. Everything else is dropped, because the
 * object is public by URL: `tEXt`/`zTXt`/`iTXt` (XMP, author, and the whole
 * generation prompt in a Stable Diffusion or ComfyUI PNG), `eXIf`, `tIME`,
 * APNG's `acTL`/`fcTL`/`fdAT` (so an animation stores as its default image),
 * and any chunk this list does not name. `iCCP` also never travels as-is:
 * its profile name and compressed ICC tags can identify a user or device, so
 * the web sends such a PNG through canvas conversion to sRGB; the agent
 * path drops the profile.
 * Fixed-size kept chunks are length-checked before any bytes are copied, so
 * a chunk with a trusted name cannot carry arbitrary text as extra data.
 *
 * Typed read-only because it is exported from core's barrel: adding a name here
 * publishes that chunk from every PNG either path keeps, so a change is a
 * reviewed edit to this list, never a call from a consumer.
 */
export const PNG_KEEP: ReadonlySet<string> = new Set([
  'IHDR',
  'PLTE',
  'tRNS',
  'IDAT',
  'IEND',
  'gAMA',
  'cHRM',
  'sRGB',
  'cICP',
  'mDCV',
  'cLLI',
  'sBIT',
  'pHYs',
]);

/** PNG-defined lengths prevent a kept chunk name from hiding free-form bytes. */
export function validKeptPngChunkLength(name: string, length: number): boolean {
  switch (name) {
    case 'IHDR':
      return length === 13;
    case 'IEND':
      return length === 0;
    case 'gAMA':
    case 'cICP':
      return length === 4;
    case 'cHRM':
      return length === 32;
    case 'sRGB':
      return length === 1;
    case 'pHYs':
      return length === 9;
    case 'mDCV':
      return length === 24;
    case 'cLLI':
      return length === 8;
    case 'sBIT':
      return length >= 1 && length <= 4;
    case 'PLTE':
      return length > 0 && length <= 768 && length % 3 === 0;
    case 'tRNS':
      return length <= 256;
    case 'IDAT':
      return true;
    default:
      return false;
  }
}

/** Longest edge accepted by the agent path. Claude's API caps images at 8000 px;
 * this path cannot decode and resize as the web does. */
export const AGENT_IMAGE_MAX_EDGE = 8000;

export type PngWalk =
  | { ok: false }
  | {
      ok: true;
      width: number;
      height: number;
      chunks: ReadonlyArray<{ name: string; start: number; end: number }>;
      trailing: boolean;
    };
type PngWalkOk = Extract<PngWalk, { ok: true }>;

/** Identify the format from bytes only. */
export function sniffImageKind(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value))
    return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

/** Bounded TIFF header and IFD0 parser shared by PNG eXIf and JPEG Exif. */
export function readTiffOrientation(
  tiff: Uint8Array,
): { ok: true; orientation: number | null } | { ok: false } {
  if (tiff.length < 8) return { ok: false };
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return { ok: false };
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, little) !== 42) return { ok: false };
  const offset = view.getUint32(4, little);
  if (offset < 8 || offset + 2 > tiff.length) return { ok: false };
  const count = view.getUint16(offset, little);
  if (offset + 2 + count * 12 > tiff.length) return { ok: false };
  let orientation: number | null = null;
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    if (
      orientation !== null ||
      view.getUint16(entry + 2, little) !== 3 ||
      view.getUint32(entry + 4, little) !== 1
    )
      return { ok: false };
    orientation = view.getUint16(entry + 8, little);
    if (orientation > 8) return { ok: false };
  }
  return { ok: true, orientation };
}

/** Walk PNG framing without applying either caller's metadata or size policy. */
export function walkPng(bytes: Uint8Array): PngWalk {
  if (sniffImageKind(bytes) !== 'png') return { ok: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { name: string; start: number; end: number }[] = [];
  let offset = 8;
  let width = 0;
  let height = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) return { ok: false };
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return { ok: false };
    const name = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    if (chunks.length === 0) {
      if (name !== 'IHDR' || length !== 13) return { ok: false };
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (!width || !height) return { ok: false };
    }
    if (PNG_KEEP.has(name) && !validKeptPngChunkLength(name, length)) return { ok: false };
    chunks.push({ name, start: offset, end });
    offset = end;
    if (name === 'IEND') {
      if (length !== 0) return { ok: false };
      return { ok: true, width, height, chunks, trailing: offset !== bytes.length };
    }
  }
  return { ok: false };
}

/** Copy the PNG signature and allowed chunks into an exact, fresh array. */
export function keptPngBytes(bytes: Uint8Array, walk: PngWalkOk): Uint8Array {
  const chunks = walk.chunks.filter((chunk) => PNG_KEEP.has(chunk.name));
  const output = new Uint8Array(
    8 + chunks.reduce((size, chunk) => size + chunk.end - chunk.start, 0),
  );
  output.set(bytes.subarray(0, 8));
  let offset = 8;
  for (const chunk of chunks) {
    output.set(bytes.subarray(chunk.start, chunk.end), offset);
    offset += chunk.end - chunk.start;
  }
  return output;
}

export type SanitizeRefusal =
  | 'not_an_image'
  | 'malformed'
  | 'unsupported_jpeg'
  | 'metadata_unreadable'
  | 'rotated'
  | 'too_wide'
  | 'too_large';
export type SanitizedImage =
  | {
      ok: true;
      bytes: Uint8Array;
      ext: 'png' | 'jpg';
      contentType: 'image/png' | 'image/jpeg';
      width: number;
      height: number;
    }
  | { ok: false; code: SanitizeRefusal; message: string };
export const SANITIZE_REFUSAL_MESSAGES: Readonly<Record<SanitizeRefusal, string>> = {
  not_an_image:
    'Only PNG and JPEG images can be uploaded. Convert the file to PNG or JPEG and retry.',
  malformed: 'The image bytes are malformed or incomplete. Save the image again and retry.',
  unsupported_jpeg:
    'This JPEG encoding is unsupported. Save it as a standard 8-bit JPEG and retry.',
  metadata_unreadable:
    'Image orientation metadata cannot be read safely. Save a new copy and retry.',
  rotated:
    'This image relies on EXIF rotation, which is removed before upload. Rotate it upright, save it, and retry.',
  too_wide: 'An image edge exceeds 8000 pixels. Downscale the image and retry.',
  too_large:
    'The image exceeds 3.5 MiB after stripping. Downscale it or convert it to JPEG and retry.',
};
const refuse = (code: SanitizeRefusal): SanitizedImage => ({
  ok: false,
  code,
  message: SANITIZE_REFUSAL_MESSAGES[code],
});
/** Whether `value` is spelled in `bytes` from `start`, without reading past `end`. */
const ascii = (bytes: Uint8Array, start: number, end: number, value: string): boolean =>
  start + value.length <= end &&
  [...value].every((character, index) => bytes[start + index] === character.charCodeAt(0));

function sanitizePng(bytes: Uint8Array): SanitizedImage {
  const walk = walkPng(bytes);
  if (!walk.ok || !walk.chunks.some((chunk) => chunk.name === 'IDAT')) return refuse('malformed');
  if (walk.chunks.filter((chunk) => chunk.name === 'IHDR').length !== 1) return refuse('malformed');
  const exif = walk.chunks.filter((chunk) => chunk.name === 'eXIf');
  if (exif.length > 1) return refuse('metadata_unreadable');
  const one = exif[0];
  if (one) {
    const start = one.start + 8;
    const payload = bytes.subarray(start, one.end - 4);
    const tiff = payload.subarray(ascii(payload, 0, payload.length, 'Exif\0') ? 6 : 0);
    const orientation = readTiffOrientation(tiff);
    if (!orientation.ok) return refuse('metadata_unreadable');
    if (orientation.orientation !== null && orientation.orientation >= 2) return refuse('rotated');
  }
  if (walk.width > AGENT_IMAGE_MAX_EDGE || walk.height > AGENT_IMAGE_MAX_EDGE)
    return refuse('too_wide');
  const output = keptPngBytes(bytes, walk);
  if (output.length > MAX_LOSSLESS_BYTES) return refuse('too_large');
  return {
    ok: true,
    bytes: output,
    ext: 'png',
    contentType: 'image/png',
    width: walk.width,
    height: walk.height,
  };
}

function tablesValid(bytes: Uint8Array, start: number, end: number, dht: boolean): boolean {
  let at = start;
  if (at === end) return false;
  while (at < end) {
    const table = bytes[at++];
    if (table === undefined) return false;
    if (dht) {
      if (at + 16 > end) return false;
      let symbols = 0;
      for (let i = 0; i < 16; i++) symbols += bytes[at + i] ?? 0;
      at += 16;
      if (symbols > 256) return false;
      at += symbols;
    } else {
      const precision = table >>> 4;
      if (precision > 1) return false;
      at += precision === 0 ? 64 : 128;
    }
  }
  return at === end;
}

function sanitizeJpeg(bytes: Uint8Array): SanitizedImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: { start: number; end: number }[] = [];
  let at = 2,
    width = 0,
    height = 0,
    sof = false,
    scans = 0,
    exif = false,
    rotated = false;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return refuse('malformed');
    const start = at;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0x00) return refuse('malformed');
    if (marker === 0xd9) {
      if (!sof || !scans) return refuse('malformed');
      if (rotated) return refuse('rotated');
      kept.push({ start, end: at });
      const size = kept.reduce((sum, part) => sum + part.end - part.start, 2);
      if (width > AGENT_IMAGE_MAX_EDGE || height > AGENT_IMAGE_MAX_EDGE) return refuse('too_wide');
      if (size > MAX_LOSSLESS_BYTES) return refuse('too_large');
      const output = new Uint8Array(size);
      output.set(bytes.subarray(0, 2));
      let cursor = 2;
      for (const part of kept) {
        output.set(bytes.subarray(part.start, part.end), cursor);
        cursor += part.end - part.start;
      }
      return { ok: true, bytes: output, ext: 'jpg', contentType: 'image/jpeg', width, height };
    }
    if (
      marker === 0xc3 ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      marker === 0xc8 ||
      (marker >= 0xc9 && marker <= 0xcf) ||
      marker === 0xde ||
      marker === 0xdf ||
      (marker >= 0xf0 && marker <= 0xfd)
    )
      return refuse('unsupported_jpeg');
    const allowed =
      marker === 0xdb ||
      marker === 0xc4 ||
      marker === 0xdd ||
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xda ||
      (marker >= 0xe0 && marker <= 0xef) ||
      marker === 0xfe;
    if (!allowed || at + 2 > bytes.length) return refuse('malformed');
    const length = view.getUint16(at);
    if (length < 2 || at + length > bytes.length) return refuse('malformed');
    const payload = at + 2,
      end = at + length;
    let keep = false;
    if (marker === 0xdb || marker === 0xc4) {
      if (!tablesValid(bytes, payload, end, marker === 0xc4)) return refuse('malformed');
      keep = true;
    } else if (marker === 0xdd) {
      if (length !== 4) return refuse('malformed');
      keep = true;
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (sof || scans || length < 8) return refuse('malformed');
      const precision = bytes[payload],
        nf = bytes[payload + 5];
      if (precision !== 8 || (nf !== 1 && nf !== 3 && nf !== 4)) return refuse('unsupported_jpeg');
      if (length !== 8 + 3 * nf) return refuse('malformed');
      height = view.getUint16(payload + 1);
      width = view.getUint16(payload + 3);
      if (!width || !height) return refuse('malformed');
      sof = true;
      keep = true;
    } else if (marker === 0xda) {
      if (!sof || length < 6) return refuse('malformed');
      const ns = bytes[payload];
      if (ns === undefined || length !== 6 + 2 * ns) return refuse('malformed');
      scans++;
      at = end;
      while (at < bytes.length) {
        if (bytes[at] !== 0xff) {
          at++;
          continue;
        }
        const candidate = at;
        while (bytes[at] === 0xff) at++;
        const next = bytes[at];
        if (next === undefined) return refuse('malformed');
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          at++;
          continue;
        }
        at = candidate;
        break;
      }
      kept.push({ start, end: at });
      if (at === bytes.length) return refuse('malformed');
      continue;
    } else if (marker === 0xe0) {
      keep =
        length === 16 &&
        ascii(bytes, payload, end, 'JFIF\0') &&
        bytes[end - 2] === 0 &&
        bytes[end - 1] === 0;
    } else if (marker === 0xee) {
      if (ascii(bytes, payload, end, 'Adobe')) {
        if (length !== 14) return refuse('malformed');
        keep = true;
      }
    } else if (marker === 0xe1 && ascii(bytes, payload, end, 'Exif\0')) {
      if (exif) return refuse('metadata_unreadable');
      exif = true;
      const orientation = readTiffOrientation(bytes.subarray(payload + 6, end));
      if (!orientation.ok) return refuse('metadata_unreadable');
      if (orientation.orientation !== null && orientation.orientation >= 2) rotated = true;
    }
    if (keep) kept.push({ start, end });
    at = end;
  }
  return refuse('malformed');
}

/** Strip image metadata at byte level without decoding or resizing. Never throws. */
export function sanitizeImageForUpload(bytes: Uint8Array): SanitizedImage {
  try {
    const kind = sniffImageKind(bytes);
    if (kind === 'png') return sanitizePng(bytes);
    if (kind === 'jpeg') return sanitizeJpeg(bytes);
    return refuse('not_an_image');
  } catch {
    return refuse('malformed');
  }
}
