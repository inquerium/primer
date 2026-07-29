/**
 * A QR code, in about two hundred lines and no dependencies.
 *
 * This exists for one moment: a parent has primer running on a laptop and wants it
 * on the child's tablet. Typing `http://192.168.1.14:7333/k/ada` into a tablet is
 * the kind of small friction that stops a thing being used at all. Pointing a
 * camera at the screen is not.
 *
 * Byte mode, error correction level M, versions 1-10 — plenty for a LAN URL.
 */

const EC_CODEWORDS: Record<number, number> = {
  1: 10, 2: 16, 3: 26, 4: 36, 5: 48, 6: 64, 7: 72, 8: 88, 9: 110, 10: 130,
};
/** Total data codewords at level M, per version. */
const DATA_CODEWORDS: Record<number, number> = {
  1: 16, 2: 28, 3: 44, 4: 64, 5: 86, 6: 108, 7: 124, 8: 154, 9: 182, 10: 216,
};
/** [blocks in group 1, blocks in group 2] at level M. */
const BLOCKS: Record<number, [number, number]> = {
  1: [1, 0], 2: [1, 0], 3: [1, 0], 4: [2, 0], 5: [2, 0],
  6: [4, 0], 7: [4, 0], 8: [2, 2], 9: [3, 2], 10: [4, 1],
};
const ALIGNMENT: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/* ------------------------------------------------------ galois field maths -- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= mul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function ecBytes(data: number[], count: number): number[] {
  const gen = generatorPoly(count);
  const remainder = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < gen.length - 1; i++) {
      remainder[i] ^= mul(gen[i + 1]!, factor);
    }
  }
  return remainder;
}

/* ------------------------------------------------------------------ encode -- */

function pickVersion(byteLength: number): number {
  for (let v = 1; v <= 10; v++) {
    const headerBits = 4 + (v < 10 ? 8 : 16);
    if (DATA_CODEWORDS[v]! * 8 >= headerBits + byteLength * 8) return v;
  }
  throw new Error('QR: content too long for version 10');
}

function encodeData(text: string, version: number): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacity = DATA_CODEWORDS[version]! * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0); // terminator
  while (bits.length % 8) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  // Alternating pad bytes, as the spec requires.
  const pads = [0xec, 0x11];
  let p = 0;
  while (codewords.length < DATA_CODEWORDS[version]!) codewords.push(pads[p++ % 2]!);
  return codewords;
}

function interleave(codewords: number[], version: number): number[] {
  const [g1, g2] = BLOCKS[version]!;
  const totalBlocks = g1 + g2;
  const ecPerBlock = EC_CODEWORDS[version]!;
  const shortLength = Math.floor(DATA_CODEWORDS[version]! / totalBlocks);

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < totalBlocks; i++) {
    const length = i < g1 ? shortLength : shortLength + 1;
    const block = codewords.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocks.push(ecBytes(block, ecPerBlock));
  }

  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return out;
}

/* ------------------------------------------------------------------ matrix -- */

type Grid = (0 | 1 | null)[][];

function buildMatrix(version: number, bytes: number[]): Grid {
  const size = version * 4 + 17;
  const grid: Grid = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));

  const place = (r: number, c: number, v: 0 | 1) => {
    grid[r]![c] = v;
    reserved[r]![c] = true;
  };

  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const edge = r === -1 || r === 7 || c === -1 || c === 7;
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        place(rr, cc, edge ? 0 : ring || core ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const v: 0 | 1 = i % 2 === 0 ? 1 : 0;
    place(6, i, v);
    place(i, 6, v);
  }

  const centres = ALIGNMENT[version]!;
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          place(r + dr, c + dc, ring === 1 ? 0 : 1);
        }
      }
    }
  }

  // Format areas, filled in properly once the mask is known.
  for (let i = 0; i < 9; i++) {
    if (!reserved[8]![i]) place(8, i, 0);
    if (!reserved[i]![8]) place(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8]![size - 1 - i]) place(8, size - 1 - i, 0);
    if (!reserved[size - 1 - i]![8]) place(size - 1 - i, 8, 0);
  }
  place(size - 8, 8, 1); // the always-dark module

  // Zig-zag the data in from the bottom right.
  const bits: number[] = [];
  for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);

  let bit = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (reserved[row]![c]) continue;
        grid[row]![c] = ((bits[bit++] ?? 0) as 0 | 1);
      }
    }
    upward = !upward;
  }

  // Mask 0 — the simplest, and legal. Applied to data modules only.
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r]![c] && (r + c) % 2 === 0) {
        grid[r]![c] = (grid[r]![c] ? 0 : 1) as 0 | 1;
      }
    }
  }

  writeFormat(grid, reserved, size);
  return grid;
}

/** Format info: level M (0b00) with mask 0, BCH-encoded and XOR-masked per spec. */
function writeFormat(grid: Grid, reserved: boolean[][], size: number): void {
  const data = (0b00 << 3) | 0; // EC level M, mask pattern 0
  let value = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (value & (1 << (i + 10))) value ^= 0b10100110111 << i;
  }
  const format = ((data << 10) | value) ^ 0b101010000010010;

  const bitAt = (i: number) => ((format >> i) & 1) as 0 | 1;
  for (let i = 0; i <= 5; i++) grid[8]![i] = bitAt(i);
  grid[8]![7] = bitAt(6);
  grid[8]![8] = bitAt(7);
  grid[7]![8] = bitAt(8);
  for (let i = 9; i <= 14; i++) grid[14 - i]![8] = bitAt(i);

  // The second copy is split 7 / 8, not 8 / 7: bits 0-6 run up the left column,
  // bits 7-14 run along the bottom row. Taking eight bits in the column instead
  // lands on the dark module at (size-8, 8) and quietly corrupts both.
  for (let i = 0; i <= 6; i++) grid[size - 1 - i]![8] = bitAt(i);
  for (let i = 7; i <= 14; i++) grid[8]![size - 15 + i] = bitAt(i);
  grid[size - 8]![8] = 1; // written last: the dark module is not format data
  void reserved;
}

/* ------------------------------------------------------------------ output -- */

export function qrMatrix(text: string): (0 | 1)[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length);
  const codewords = encodeData(text, version);
  const final = interleave(codewords, version);
  return buildMatrix(version, final) as (0 | 1)[][];
}

/** An SVG QR code with the quiet zone the spec requires. Scanners need it. */
export function qrSvg(text: string, opts: { size?: number; dark?: string; light?: string } = {}): string {
  const matrix = qrMatrix(text);
  const quiet = 4;
  const modules = matrix.length + quiet * 2;
  const dark = opts.dark ?? '#241c15';
  const light = opts.light ?? '#ffffff';

  let path = '';
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r]![c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const px = opts.size ?? 220;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${modules} ${modules}" shape-rendering="crispEdges" role="img" aria-label="QR code">
<rect width="${modules}" height="${modules}" fill="${light}"/>
<path d="${path}" fill="${dark}"/>
</svg>`;
}
