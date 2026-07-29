/**
 * Build a single-file primer.
 *
 * Two artefacts, from the same bundle:
 *
 *   build/primer.cjs   one file, needs Node 22.13+ on the machine
 *   build/primer(.exe) a standalone executable, needs nothing
 *
 * The second is the one that matters for the people this is for. Claude Code
 * itself ships as a native binary installed by one pasted line — a parent who has
 * it does not thereby have Node, and asking them to install a toolchain to run a
 * reading app is where this stops being usable.
 *
 *   node scripts/package.mjs          # bundle only
 *   node scripts/package.mjs --binary # bundle, then build the executable
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const wantBinary = process.argv.includes('--binary');

rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });

/* ------------------------------------------------------------------ bundle -- */

// CommonJS on purpose: Node's single-executable support ignores `mainFormat:
// "module"` on the current LTS, and an ESM entry point fails at runtime with
// "Cannot use import statement outside a module".
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    join(root, 'src', 'cli.ts'),
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=cjs',
    '--legal-comments=none',
    // Everything the record needs is inlined, including the assets module, so the
    // bundle has no filesystem dependencies of its own.
    `--outfile=${join(build, 'primer.cjs')}`,
    // The source is ESM and uses `import.meta.url` to find its own directory.
    // esbuild leaves that expression undefined in a CJS bundle, so every
    // `fileURLToPath(import.meta.url)` throws at load. Point it at a real file URL
    // computed from __filename instead. The paths it yields do not exist inside a
    // binary, which is exactly why every asset lookup falls back to the embedded copy.
    '--banner:js=var __PRIMER_URL__ = require("node:url").pathToFileURL(__filename).href;',
    '--define:import.meta.url=__PRIMER_URL__',
  ],
  { stdio: 'inherit', cwd: root },
);

const bundleSize = statSync(join(build, 'primer.cjs')).size;
console.log(`bundle: build/primer.cjs (${Math.round(bundleSize / 1024)}KB)`);

if (!wantBinary) process.exit(0);

/* ------------------------------------------------------------------ binary -- */

const config = join(build, 'sea-config.json');
writeFileSync(
  config,
  JSON.stringify(
    {
      main: join(build, 'primer.cjs'),
      output: join(build, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

execFileSync(process.execPath, ['--experimental-sea-config', config], {
  stdio: 'inherit',
  cwd: root,
});

const windows = process.platform === 'win32';
const target = join(build, windows ? 'primer.exe' : 'primer');
copyFileSync(process.execPath, target);

// macOS refuses to run an arm64 binary whose signature no longer matches, and
// injection invalidates whatever signature node arrived with.
if (process.platform === 'darwin') {
  try {
    execFileSync('codesign', ['--remove-signature', target], { stdio: 'inherit' });
  } catch {
    console.warn('codesign --remove-signature failed; continuing');
  }
}

execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
    target,
    'NODE_SEA_BLOB',
    join(build, 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ],
  { stdio: 'inherit', cwd: root },
);

if (process.platform === 'darwin') {
  try {
    // Ad-hoc is enough for Apple Silicon to run it at all; a real signature is a
    // separate, paid step and only affects the download warning.
    execFileSync('codesign', ['--sign', '-', target], { stdio: 'inherit' });
  } catch {
    console.warn('ad-hoc codesign failed; the binary may not run on Apple Silicon');
  }
}

if (!existsSync(target)) throw new Error('the executable was not produced');
console.log(`binary: ${target} (${Math.round(statSync(target).size / 1024 / 1024)}MB)`);
