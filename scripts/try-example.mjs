/**
 * Load the reference interface into a record and serve it, so you can click
 * through it and watch evidence arrive. Not part of the library — a dev aid.
 *
 *   node scripts/try-example.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Dynamic import needs a file:// URL — a bare Windows path reads as protocol "c:".
const src = (p) => pathToFileURL(join(root, 'src', p)).href;

const { db } = await import(src('db/index.ts'));
const { loadCurriculum } = await import(src('curriculum/load.ts'));
const { seedDemo } = await import(src('demo.ts'));
const { saveInterface } = await import(src('surface/store.ts'));
const { createSurfaceServer } = await import(src('surface/server.ts'));

db();
loadCurriculum();
const { learner } = seedDemo('Ada');

const iface = saveInterface(learner.id, {
  title: 'The dig site — short e minimal pairs',
  kind: 'game',
  target_skills: ['ph_cvc_short_e'],
  html: readFileSync(join(root, 'examples', 'short-e-minimal-pairs.html'), 'utf8'),
  spec: {
    from_misconception: 'Reads short e as short i',
    uses_interest: 'dinosaurs',
    honors: ['no_timers', 'typography'],
    shape: 'choose between two visible words rather than produce one',
  },
});

const surface = createSurfaceServer(Number(process.env.PRIMER_PORT ?? 7333));
await surface.listen();
console.log(surface.urlFor(iface.id));
