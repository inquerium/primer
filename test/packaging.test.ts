import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPackaged } from '../src/agent/claude-code.ts';
import { SCHEMA_SQL, RUNTIME_JS, MIGRATIONS, CURRICULUM } from '../src/generated/assets.ts';

/**
 * Packaging is the part of this project a contributor never exercises and a user
 * hits first. These tests check the invariants that, when they break, break the
 * install rather than the software — a wrong asset name means every download is a
 * 404, and a missing embedded asset means the binary starts and then has no
 * curriculum.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('running from source is not mistaken for a packaged binary', () => {
  // If this ever flips, the tutor tells Claude Code to launch the MCP server by
  // running the current executable with no script, and every unattended run dies.
  assert.equal(isPackaged(), false);
});

test('every asset the installers download is one the release workflow builds', () => {
  const workflow = read('.github/workflows/release.yml');
  const built = new Set([...workflow.matchAll(/asset:\s*(\S+)/g)].map((m) => m[1]!));
  assert.ok(built.size >= 5, `expected binaries for every platform, found ${built.size}`);

  // install.sh composes its name from two tags; reproduce the same combinations.
  const shell = read('install.sh');
  assert.match(shell, /asset="primer-\$\{os_tag\}-\$\{arch_tag\}"/);
  for (const os of ['macos', 'linux']) {
    for (const arch of ['x64', 'arm64']) {
      assert.ok(
        built.has(`primer-${os}-${arch}`),
        `install.sh will ask for primer-${os}-${arch}, which the release workflow never builds`,
      );
    }
  }

  const ps = read('install.ps1');
  const psAsset = /\$asset = "([^"]+)"/.exec(ps)?.[1];
  assert.equal(psAsset, 'primer-windows-$arch.exe');
  assert.ok(built.has('primer-windows-x64.exe'));
});

test('the installers verify what they downloaded', () => {
  // A truncated 90MB download is otherwise indistinguishable from a broken build,
  // and shows up as an unreadable crash much later.
  for (const file of ['install.sh', 'install.ps1']) {
    const body = read(file);
    assert.match(body, /sha256/i, `${file} does not check a checksum`);
    assert.match(body, /mismatch/i, `${file} does not refuse on a checksum mismatch`);
  }
});

test('the installers do not need root, npm, or a compiler', () => {
  const shell = read('install.sh');
  assert.doesNotMatch(shell, /^\s*sudo\s/m, 'installing a tutor should never ask for sudo');
  assert.match(shell, /\.local\/bin/, 'install where Claude Code already put itself on PATH');
  // The happy path fetches a prebuilt binary. `npm` is allowed to be *mentioned* —
  // in a comment, or in the message that tells someone with no published release
  // to build from source — but never run.
  const executed = shell
    .replace(/die "[\s\S]*?"/g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'));
  assert.ok(
    !executed.some((line) => /(^|[;&|]\s*)npm\s/.test(line)),
    'installing must not require a toolchain',
  );
  assert.match(shell, /curl -fsSL "\$url"/, 'the installer must download the release asset');
});

test('the record can be built with no repository on disk', () => {
  // Everything the binary needs to create a working record from nothing.
  assert.match(SCHEMA_SQL, /CREATE TABLE.+learner/is);
  assert.match(SCHEMA_SQL, /CREATE TABLE.+observation/is);
  assert.ok(RUNTIME_JS.includes('observe'), 'the activity runtime must be embedded');
  assert.ok(MIGRATIONS.length >= 3, `only ${MIGRATIONS.length} migrations embedded`);

  const names = MIGRATIONS.map(([name]) => name);
  assert.deepEqual(
    names,
    [...names].sort(),
    'migrations are applied in the order embedded, so they must be embedded sorted',
  );

  const skills = CURRICULUM.flatMap(
    ([, body]) => (JSON.parse(body) as { skills?: unknown[] }).skills ?? [],
  );
  assert.ok(skills.length > 100, `only ${skills.length} skills embedded`);
});

test('the packaging script bundles for the runtime that actually loads it', () => {
  const script = read('scripts/package.mjs');
  // Node's single-executable support runs the blob as CommonJS. An ESM bundle
  // builds fine and then fails at startup with "Cannot use import statement".
  assert.match(script, /--format=cjs/);
  // esbuild leaves `import.meta.url` undefined in a CJS bundle, and this project
  // uses it to locate its own assets, so every such call throws on load.
  assert.match(script, /--define:import\.meta\.url=/);
});
