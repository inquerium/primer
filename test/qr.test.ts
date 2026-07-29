import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrSvg } from '../src/surface/qr.ts';

/**
 * These check the structure of the code — the parts of the spec a scanner locks
 * onto before it reads a single data bit. They do not prove a phone can read it;
 * only a camera does that. But almost every way an encoder goes wrong shows up
 * here first.
 */

const URL = 'http://192.168.1.14:7333/k/ada';

test('the code is a legal size for its version', () => {
  const m = qrMatrix(URL);
  assert.equal(m.length, m[0]!.length, 'must be square');
  assert.equal((m.length - 17) % 4, 0, `${m.length} is not a valid QR size`);
  assert.ok(m.length >= 21 && m.length <= 57);
});

test('all three finder patterns are present and correctly formed', () => {
  const m = qrMatrix(URL);
  const size = m.length;

  // The 7x7 eye: dark ring, light ring, 3x3 dark core.
  const eye = (top: number, left: number) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(
          m[top + r]![left + c],
          ring || inner ? 1 : 0,
          `finder at (${top},${left}) wrong at ${r},${c}`,
        );
      }
    }
  };
  eye(0, 0);
  eye(0, size - 7);
  eye(size - 7, 0);
});

test('the separators around each finder are light', () => {
  const m = qrMatrix(URL);
  const size = m.length;
  for (let i = 0; i < 8; i++) {
    assert.equal(m[7]![i], 0, 'separator below top-left');
    assert.equal(m[i]![7], 0, 'separator right of top-left');
    assert.equal(m[7]![size - 1 - i], 0, 'separator below top-right');
    assert.equal(m[size - 1 - i]![7], 0, 'separator above bottom-left');
  }
});

test('the timing patterns alternate', () => {
  const m = qrMatrix(URL);
  for (let i = 8; i < m.length - 8; i++) {
    const expected = i % 2 === 0 ? 1 : 0;
    assert.equal(m[6]![i], expected, `horizontal timing wrong at ${i}`);
    assert.equal(m[i]![6], expected, `vertical timing wrong at ${i}`);
  }
});

test('the dark module is where the spec puts it', () => {
  const m = qrMatrix(URL);
  assert.equal(m[m.length - 8]![8], 1);
});

test('format bits are the documented value for level M with mask 0', () => {
  const m = qrMatrix(URL);
  // For EC level M and mask 0 the BCH remainder is zero, so the 15 format bits
  // come out as the XOR mask itself: 101010000010010.
  //
  // They are placed least-significant bit first — module (8,0) holds bit 0 — so
  // reading them out in placement order gives that constant reversed.
  const expected = '101010000010010'.split('').reverse().map(Number);

  const read: number[] = [];
  for (let i = 0; i <= 5; i++) read.push(m[8]![i]!);
  read.push(m[8]![7]!, m[8]![8]!, m[7]![8]!);
  for (let i = 9; i <= 14; i++) read.push(m[14 - i]![8]!);

  assert.deepEqual(read, expected, 'format information does not match level M / mask 0');
});

test('the second copy of the format bits agrees with the first', () => {
  const m = qrMatrix(URL);
  const size = m.length;
  const primary: number[] = [];
  for (let i = 0; i <= 5; i++) primary.push(m[8]![i]!);
  primary.push(m[8]![7]!, m[8]![8]!, m[7]![8]!);
  for (let i = 9; i <= 14; i++) primary.push(m[14 - i]![8]!);

  // Bits 0-6 up the left column, bits 7-14 along the bottom row. The module at
  // (size-8, 8) between them is the dark module, not format data.
  const secondary: number[] = [];
  for (let i = 0; i <= 6; i++) secondary.push(m[size - 1 - i]![8]!);
  for (let i = 7; i <= 14; i++) secondary.push(m[8]![size - 15 + i]!);

  assert.deepEqual(secondary, primary, 'the two format copies disagree; a scanner would reject this');
});

test('longer content picks a bigger version rather than truncating', () => {
  const small = qrMatrix('http://10.0.0.2:7333/k/al');
  const large = qrMatrix('http://192.168.100.200:7333/k/a-much-longer-child-name-here');
  assert.ok(large.length > small.length, 'a longer URL must use a larger code');
});

test('content too long to encode fails loudly', () => {
  assert.throws(() => qrMatrix('x'.repeat(500)), /too long/);
});

test('the SVG carries the quiet zone scanners need', () => {
  const svg = qrSvg(URL, { size: 200 });
  const modules = qrMatrix(URL).length;
  assert.match(svg, /^<svg /);
  assert.match(svg, new RegExp(`viewBox="0 0 ${modules + 8} ${modules + 8}"`), 'needs 4 modules of quiet zone each side');
  assert.match(svg, /width="200" height="200"/);
  assert.match(svg, /shape-rendering="crispEdges"/, 'anti-aliasing blurs module edges');
});

test('the same input always produces the same code', () => {
  assert.deepEqual(qrMatrix(URL), qrMatrix(URL));
});

test('an address a tablet cannot reach is never offered', async () => {
  const { lanAddresses } = await import('../src/surface/pwa.ts');
  for (const address of lanAddresses()) {
    assert.ok(
      !address.startsWith('169.254.'),
      `${address} is link-local — no other device can reach it, so it must not be shown`,
    );
    assert.ok(!address.startsWith('127.'), 'loopback is not a LAN address');
  }
});
