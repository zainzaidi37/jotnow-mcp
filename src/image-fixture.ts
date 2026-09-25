// Test-only image bytes. This file is excluded from the published build.
function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

const be16 = (value: number) => new Uint8Array([value >>> 8, value & 255]);
const be32 = (value: number) =>
  new Uint8Array([value >>> 24, value >>> 16, value >>> 8, value & 255]);

function chunk(name: string, data: Uint8Array = new Uint8Array()): Uint8Array {
  const body = concat(new TextEncoder().encode(name), data);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return concat(be32(data.length), body, be32((crc ^ 0xffffffff) >>> 0));
}

export const textChunk = (): Uint8Array =>
  chunk('tEXt', new TextEncoder().encode('Note\0KJ-MARKER-TEXT'));

export function png(width = 2, height = 2, extras: Uint8Array[] = []): Uint8Array {
  const pixels = new Uint8Array(height * (1 + width * 4));
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let offset = 0; offset < pixels.length;) {
    const length = Math.min(65535, pixels.length - offset);
    blocks.push(
      new Uint8Array([
        offset + length === pixels.length ? 1 : 0,
        length & 255,
        length >>> 8,
        ~length & 255,
        (~length >>> 8) & 255,
      ]),
      pixels.subarray(offset, offset + length),
    );
    offset += length;
  }
  blocks.push(be32((((pixels.length % 65521) << 16) | 1) >>> 0));
  const zlib = concat(...blocks);
  return concat(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', concat(be32(width), be32(height), new Uint8Array([8, 6, 0, 0, 0]))),
    ...extras,
    chunk('IDAT', zlib),
    chunk('IEND'),
  );
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  return concat(new Uint8Array([255, marker]), be16(payload.length + 2), payload);
}

export function syntheticJpeg(): Uint8Array {
  const dqt = segment(0xdb, concat(new Uint8Array([0]), new Uint8Array(64)));
  const dht = segment(0xc4, new Uint8Array(17));
  const sof = segment(
    0xc0,
    concat(
      new Uint8Array([8]),
      be16(6),
      be16(8),
      new Uint8Array([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    ),
  );
  const sos = segment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0]));
  return concat(
    new Uint8Array([255, 0xd8]),
    dqt,
    dht,
    sof,
    sos,
    new Uint8Array([4, 5, 255, 0, 7, 255, 0xd0, 8, 255, 255, 0xd1, 9, 255, 0xd9]),
  );
}
