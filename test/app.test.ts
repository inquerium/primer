import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const home = mkdtempSync(join(tmpdir(), 'primer-app-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');
process.env.PRIMER_NO_ACP = '1'; // keep transport deterministic in CI

const { db, closeDb } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createSurfaceServer } = await import('../src/surface/server.ts');
const { acpAgentBinary, transportStatus } = await import('../src/agent/acp.ts');
const { settings } = await import('../src/agent/config.ts');

const PORT = 7791;
const surface = await createSurfaceServer(PORT, { lan: false });

before(async () => {
  db();
  loadCurriculum();
  await surface.listen();
});

after(async () => {
  await surface.close();
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

function http(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* html */
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('the parent app is the home page — no terminal instructions', async () => {
  const page = await http('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /class="brand">primer/);
  assert.match(page.text, /Prepare work|Add your first child|seed Ada/);
  assert.doesNotMatch(page.text, /primer learner:add/);
});

test('adding a child from the app needs no CLI', async () => {
  const created = await http('POST', '/api/app/learner', { name: 'Mira' });
  assert.equal(created.status, 200);
  assert.equal(created.json.name, 'Mira');

  const status = await http('GET', '/api/app/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.children.length, 1);
  assert.equal(status.json.children[0].name, 'Mira');
  assert.ok(status.json.transport.transport === 'cli' || status.json.transport.transport === 'acp');
});

test('Wi‑Fi / HTTPS prefs are remembered for the next start', async () => {
  const res = await http('POST', '/api/app/flags', { lan: true, https: true });
  assert.equal(res.status, 200);
  assert.equal(res.json.restart, true);
  assert.equal(settings().surface_lan, true);
  assert.equal(settings().surface_https, true);
});

test('app APIs stay on this machine', async () => {
  // Off-loopback is simulated by the security tests; here we only assert the
  // adult path list includes /api/app so LAN tokens cannot prepare work.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/surface/security.ts', import.meta.url), 'utf8');
  assert.match(src, /\/api\\\/app/);
});

test('ACP is optional — missing agent reports CLI transport', () => {
  assert.equal(acpAgentBinary(), null);
  assert.equal(transportStatus().transport, 'cli');
});
