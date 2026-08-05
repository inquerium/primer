import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPackaged } from '../src/agent/claude-code.ts';
import { diskAssetPaths } from '../src/db/index.ts';
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

test('a packaged binary never reads schema or migrations beside itself', () => {
  // A downloaded binary can sit in any directory. Neighbouring files belong to
  // that directory, not to the release, and must not change a record migration.
  assert.deepEqual(diskAssetPaths('schema.sql', true), []);
  assert.deepEqual(diskAssetPaths('migrations', true), []);
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
  assert.match(shell, /curl -fsSL[^\n]*"\$url"/, 'the installer must download the release asset');
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

test('a missing checksum refuses the install on the official path', () => {
  // Suppressing one HTTP request must not be enough to disable the only integrity
  // check an installer has. Both scripts must fail closed unless PRIMER_URL — an
  // explicit, opted-in override — is set.
  for (const file of ['install.sh', 'install.ps1']) {
    const body = read(file);
    assert.match(
      body,
      /PRIMER_URL/,
      `${file} must only skip verification for the explicit PRIMER_URL override`,
    );
  }
  const shell = read('install.sh');
  assert.match(shell, /refusing to install an unverified binary/);
  const ps = read('install.ps1');
  assert.match(ps, /refusing to install an unverified binary/);
});

test('the shipped binary does not embed the build machine’s path', () => {
  const script = read('scripts/package.mjs');
  assert.doesNotMatch(
    script,
    /main:\s*join\(build/,
    'sea-config.json main must be relative, or the build machine’s absolute path ships inside every binary',
  );
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

test('the packaging script executes esbuild as a native binary', () => {
  const script = read('scripts/package.mjs');
  assert.match(
    script,
    /execFileSync\(\s*join\(root, 'node_modules', 'esbuild', 'bin', 'esbuild'\),/s,
    'esbuild is a native executable, not a JavaScript file for Node to parse',
  );
});

test('the copied Node executable is writable before postject injects it', () => {
  const script = read('scripts/package.mjs');
  assert.match(
    script,
    /chmodSync\(target, 0o755\);/,
    'postject must be able to write into the copied Node executable',
  );
});
