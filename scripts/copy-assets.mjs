import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const [from, to] of [
  ['src/db/schema.sql', 'dist/db/schema.sql'],
  ['src/db/migrations', 'dist/db/migrations'],
  ['src/surface/runtime.js', 'dist/surface/runtime.js'],
  ['src/curriculum', 'dist/curriculum'],
]) {
  const dest = join(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(root, from), dest, { recursive: true });
}

console.log('assets copied to dist/');
