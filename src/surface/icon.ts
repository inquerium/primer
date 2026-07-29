import { deflateSync } from 'node:zlib';

/**
 * The child's home-screen icon, drawn as a PNG.
 *
 * iOS ignores SVG for `apple-touch-icon` and for manifest icons, and it does not
 * fall back to anything sensible — it screenshots the page instead. So the promise
 * that a child's app carries "their name under the icon, their own colour" quietly
 * failed on the one platform most likely to be the tablet.
 *
 * Everything here is written by hand because the alternative is a font rasterizer
 * and an image library for one 180×180 tile. A 5×7 bitmap alphabet scaled up reads
 * as deliberate rather than crude, and it is exactly reproducible on every machine.
 *
 * No alpha channel: iOS composites transparency onto black, which would put a dark
 * ring around every icon.
 */

/** 5×7 glyphs, one string of five characters per row. Enough for a first initial. */
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
};

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** hsl() as produced by colorFor, so the PNG matches the rest of the interface. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return {
    r: Math.round((r! + m) * 255),
    g: Math.round((g! + m) * 255),
    b: Math.round((b! + m) * 255),
  };
}

export function parseHsl(css: string): Rgb {
  const m = css.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/);
  if (!m) return { r: 90, g: 90, b: 110 };
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

/* -------------------------------------------------------------------- png -- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode 8-bit RGB pixels (no alpha) as a PNG. */
function encodePng(width: number, height: number, pixels: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type 2 = truecolour, no alpha
  header.writeUInt8(0, 10); // deflate
  header.writeUInt8(0, 11); // adaptive filtering
  header.writeUInt8(0, 12); // no interlace

  // One filter byte (0 = None) in front of each scanline.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- draw -- */

export interface IconOptions {
  size?: number;
  background: Rgb;
  ink?: Rgb;
}

/**
 * A solid tile with the child's initial.
 *
 * Deliberately edge-to-edge and square: iOS applies its own rounded mask, and a
 * tile that rounds its own corners ends up double-rounded with dark corners.
 */
export function letterIconPng(letter: string, opts: IconOptions): Buffer {
  const size = opts.size ?? 180;
  const ink = opts.ink ?? { r: 255, g: 253, b: 248 };
  const glyph = GLYPHS[letter.toUpperCase()] ?? GLYPHS['?']!;

  const pixels = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 3] = opts.background.r;
    pixels[i * 3 + 1] = opts.background.g;
    pixels[i * 3 + 2] = opts.background.b;
  }

  // Fit the 5×7 glyph into the middle ~55% of the tile, on whole pixels so the
  // edges stay crisp rather than smeared.
  const scale = Math.floor((size * 0.55) / 7);
  const glyphWidth = 5 * scale;
  const glyphHeight = 7 * scale;
  const originX = Math.round((size - glyphWidth) / 2);
  const originY = Math.round((size - glyphHeight) / 2);

  for (let gy = 0; gy < 7; gy++) {
    const row = glyph[gy]!;
    for (let gx = 0; gx < 5; gx++) {
      if (row[gx] !== '1') continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const px = originX + gx * scale + x;
          const py = originY + gy * scale + y;
          if (px < 0 || py < 0 || px >= size || py >= size) continue;
          const at = (py * size + px) * 3;
          pixels[at] = ink.r;
          pixels[at + 1] = ink.g;
          pixels[at + 2] = ink.b;
        }
      }
    }
  }

  return encodePng(size, size, pixels);
}
