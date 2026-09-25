import { constants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { ATTACHMENT_MAX_OBJECT_BYTES, ATTACHMENT_UPLOAD_TIMEOUT_MS } from './core/index.js';
import type { z } from 'zod';
import { imageUploadGrantSchema } from './wire.js';
import { performImagePut } from './image-upload-put.js';

export type ImageUploadGrant = z.infer<typeof imageUploadGrantSchema>;

export function resolvedImagePath(input: string): string {
  const expanded =
    input === '~' ? homedir() : /^~[\\/]/.test(input) ? resolve(homedir(), input.slice(2)) : input;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

export async function readImageFile(input: string): Promise<{ path: string; bytes: Uint8Array }> {
  const path = resolvedImagePath(input);
  let pathStat;
  try {
    pathStat = await fs.stat(path);
  } catch {
    throw new Error('Could not open the image file; check that the path exists and is readable.');
  }
  if (!pathStat.isFile()) throw new Error('Image path must name a regular file.');
  if (pathStat.size > ATTACHMENT_MAX_OBJECT_BYTES)
    throw new Error('Image file exceeds the 25 MiB input limit.');
  let handle;
  try {
    handle = await fs.open(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0),
    );
  } catch {
    throw new Error('Could not open the image file; check that the path exists and is readable.');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Image path must name a regular file.');
    if (stat.size > ATTACHMENT_MAX_OBJECT_BYTES)
      throw new Error('Image file exceeds the 25 MiB input limit.');
    const buffer = new Uint8Array(Math.min(stat.size, ATTACHMENT_MAX_OBJECT_BYTES) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > ATTACHMENT_MAX_OBJECT_BYTES)
      throw new Error('Image file exceeds the 25 MiB input limit.');
    if (length > stat.size) throw new Error('The image file changed while it was being read.');
    return { path, bytes: buffer.slice(0, length) };
  } finally {
    await handle.close();
  }
}

export function cleanImageAlt(alt?: string): string {
  const cleaned = alt
    ?.replace(/[\n\r\t\u2028\u2029]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replaceAll('\\', '');
  return (
    Array.from(cleaned ?? '')
      .slice(0, 200)
      .join('')
      .trim() || 'image'
  );
}

/** The signed URL is a credential; errors may name its host, never its path or query. */
export async function putGrantedImage(
  grant: ImageUploadGrant,
  bytes: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const safe = imageUploadGrantSchema.safeParse(grant);
  if (!safe.success) throw new Error('The server offered an unsafe upload grant.');
  await performImagePut(safe.data, bytes, fetchImpl, ATTACHMENT_UPLOAD_TIMEOUT_MS);
}
