/**
 * Stand in for one autonomous run: queue the reference interface for the demo
 * child so you can walk the parent gate and the child page without an API key.
 *
 *   node --experimental-strip-types scripts/try-queue.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => pathToFileURL(join(root, 'src', p)).href;

const { db } = await import(src('db/index.ts'));
const { loadCurriculum } = await import(src('curriculum/load.ts'));
const { seedDemo } = await import(src('demo.ts'));
const { saveInterface } = await import(src('surface/store.ts'));
const { planActivity } = await import(src('record/queue.ts'));
const { createSurfaceServer } = await import(src('surface/server.ts'));

db();
loadCurriculum();
const { learner } = seedDemo('Ada');

const iface = saveInterface(learner.id, {
  title: 'The dig site — short e minimal pairs',
  kind: 'game',
  target_skills: ['ph_cvc_short_e'],
  html: readFileSync(join(root, 'examples', 'short-e-minimal-pairs.html'), 'utf8'),
  spec: { from_misconception: 'Reads short e as short i', uses_interest: 'dinosaurs' },
});

planActivity(learner.id, {
  interface_id: iface.id,
  title: 'The dig site — short e minimal pairs',
  rationale:
    'She has read short e as short i in four sessions running, and it now shows up in her spelling ' +
    'too, so it is one misconception rather than two. Choosing between two visible words costs her ' +
    'less than producing one aloud. Eight items, dinosaur framing, ends on the easiest pair.',
  target_skills: ['ph_cvc_short_e'],
});

const surface = createSurfaceServer(Number(process.env.PRIMER_PORT ?? 7333));
await surface.listen();
console.log(`review: ${surface.origin}/review`);
console.log(`child:  ${surface.origin}/child/${learner.id}`);
