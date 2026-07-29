import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { letterIconPng, parseHsl, hslToRgb } from '../src/surface/icon.ts';

/** Walk the chunk list the way a decoder would, so a malformed file is caught. */
function readChunks(png: Buffer) {
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG signature',
  );
  const chunks: { type: string; data: Buffer }[] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('ascii');
    const data = png.subarray(at + 8, at + 8 + length);
    chunks.push({ type, data });
    at += 12 + length;
  }
  return chunks;
}

test('the icon is a structurally valid PNG', () => {
  const png = letterIconPng('A', { background: { r: 10, g: 20, b: 30 } });
  const chunks = readChunks(png);
  assert.equal(chunks[0]!.type, 'IHDR');
  assert.equal(chunks.at(-1)!.type, 'IEND');
  assert.ok(chunks.some((c) => c.type === 'IDAT'));
});

test('it is 180x180 truecolour with no alpha, as iOS requires', () => {
  const ihdr = readChunks(letterIconPng('A', { background: { r: 0, g: 0, b: 0 } }))[0]!.data;
  assert.equal(ihdr.readUInt32BE(0), 180, 'width');
  assert.equal(ihdr.readUInt32BE(4), 180, 'height');
  assert.equal(ihdr.readUInt8(8), 8, 'bit depth');
  // Colour type 2 = RGB. Type 6 would carry alpha, which iOS composites onto
  // black, ringing every icon in a dark border.
  assert.equal(ihdr.readUInt8(9), 2, 'colour type must be truecolour without alpha');
  assert.equal(ihdr.readUInt8(12), 0, 'not interlaced');
});

test('the pixels decode back to the colours that went in', () => {
  const bg = { r: 200, g: 30, b: 90 };
  const ink = { r: 255, g: 255, b: 255 };
  const png = letterIconPng('H', { size: 64, background: bg, ink });
  const idat = readChunks(png).find((c) => c.type === 'IDAT')!.data;
  const raw = inflateSync(idat);

  const stride = 64 * 3;
  assert.equal(raw.length, (stride + 1) * 64, 'one filter byte per scanline');
  for (let y = 0; y < 64; y++) {
    assert.equal(raw[y * (stride + 1)], 0, `scanline ${y} uses filter None`);
  }

  const pixelAt = (x: number, y: number) => {
    const at = y * (stride + 1) + 1 + x * 3;
    return { r: raw[at], g: raw[at + 1], b: raw[at + 2] };
  };
  assert.deepEqual(pixelAt(0, 0), bg, 'corner is the background colour');
  assert.deepEqual(pixelAt(63, 63), bg, 'opposite corner too');

  // An H has ink in the middle of the tile somewhere.
  let inkPixels = 0;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const p = pixelAt(x, y);
      if (p.r === ink.r && p.g === ink.g && p.b === ink.b) inkPixels++;
    }
  }
  assert.ok(inkPixels > 100, `the letter should actually be drawn, found ${inkPixels} ink pixels`);
});

test('different letters produce different icons', () => {
  const bg = { r: 50, g: 60, b: 70 };
  const a = letterIconPng('A', { background: bg });
  const b = letterIconPng('B', { background: bg });
  assert.ok(!a.equals(b), 'A and B must not render identically');
});

test('an unusual first character falls back rather than crashing', () => {
  for (const initial of ['?', '🙂', 'Ω', '']) {
    const png = letterIconPng(initial, { background: { r: 1, g: 2, b: 3 } });
    assert.ok(png.length > 100, `"${initial}" should still produce an icon`);
    assert.equal(readChunks(png)[0]!.type, 'IHDR');
  }
});

test('lowercase and uppercase initials render the same', () => {
  const bg = { r: 9, g: 9, b: 9 };
  assert.ok(letterIconPng('a', { background: bg }).equals(letterIconPng('A', { background: bg })));
});

test('the icon colour matches the one used everywhere else', () => {
  // colorFor emits hsl(); the PNG has to resolve it to the same colour or the
  // tile will not match the child's card in the parent interface.
  assert.deepEqual(hslToRgb(0, 100, 50), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hslToRgb(120, 100, 50), { r: 0, g: 255, b: 0 });
  assert.deepEqual(hslToRgb(240, 100, 50), { r: 0, g: 0, b: 255 });
  assert.deepEqual(parseHsl('hsl(0 100% 50%)'), { r: 255, g: 0, b: 0 });

  const parsed = parseHsl('hsl(19 62% 46%)');
  assert.ok(parsed.r > parsed.g && parsed.g > parsed.b, 'a warm orange, as the CSS says');
  // Nonsense in, something sane out, rather than a crash.
  assert.ok(parseHsl('not a colour').r >= 0);
});

test('sizes are honoured so a platform gets the resolution it asked for', () => {
  for (const size of [64, 180, 192, 512]) {
    const ihdr = readChunks(letterIconPng('Z', { size, background: { r: 0, g: 0, b: 0 } }))[0]!.data;
    assert.equal(ihdr.readUInt32BE(0), size);
    assert.equal(ihdr.readUInt32BE(4), size);
  }
});
