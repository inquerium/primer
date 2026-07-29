import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const home = mkdtempSync(join(tmpdir(), 'primer-sec-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb, all } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createLearner } = await import('../src/record/learners.ts');
const { createSurfaceServer } = await import('../src/surface/server.ts');
const { childToken } = await import('../src/surface/security.ts');
const { slugFor } = await import('../src/surface/pwa.ts');

// Bound to loopback but told it may serve the network, so both paths are testable.
const surface = createSurfaceServer(7771, { lan: true });
const PORT = 7771;
const BASE = `http://127.0.0.1:${PORT}`;
let learnerId = '';
let slug = '';
let token = '';
const { lanAddresses } = await import('../src/surface/pwa.ts');
// A real address of this machine, so the Host check passes and the token check is
// what is actually under test.
const LAN = lanAddresses()[0] ?? '127.0.0.1';

before(async () => {
  db();
  loadCurriculum();
  const learner = createLearner({ display_name: 'Guarded Child' });
  learnerId = learner.id;
  slug = slugFor(learner);
  token = childToken();
  await surface.listen();
});

after(async () => {
  await surface.close();
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

/** fetch() refuses to set Host, so speak HTTP directly for that one case. */
function rawGet(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { Host: host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('a request claiming an unknown hostname is refused', async () => {
  // DNS rebinding: a page on evil.example points that hostname at 127.0.0.1 and
  // then reads this server same-origin — the whole record, including audio of the
  // child, off a laptop that never enabled LAN mode. The attacker controls the
  // DNS but not the Host header, so this check is the entire defence.
  assert.equal(
    await rawGet(`/progress/${slug}`, 'evil.example.com'),
    403,
    'an unrecognised Host must never be served',
  );
  assert.equal(await rawGet(`/progress/${slug}`, `127.0.0.1:${PORT}`), 200, 'the real host works');
  assert.equal(await rawGet(`/progress/${slug}`, `localhost:${PORT}`), 200);
});

test('a write from another site is refused', async () => {
  const res = await fetch(`${BASE}/api/observe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example.com',
    },
    body: JSON.stringify({ learner_id: learnerId, observations: [{ skill_id: 'cc_count_to_10', correct: 1 }] }),
  });
  assert.equal(res.status, 403, 'cross-origin writes must be refused');
  assert.equal(
    all<{ n: number }>(`SELECT count(*) AS n FROM observation`)[0]!.n,
    0,
    'and nothing may reach the record',
  );
});

test('a cross-site fetch is refused even without an Origin header', async () => {
  const res = await fetch(`${BASE}/api/interest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ learner_id: learnerId, topic: 'injected' }),
  });
  assert.equal(res.status, 403);
});

test('the adult pages never leave this machine', async () => {
  // Simulated by asking as a non-loopback peer would: the guard keys off the
  // socket, so here we assert the policy directly.
  const { guard } = await import('../src/surface/security.ts');
  const fakeRemote = (path: string, headers: Record<string, string> = {}) =>
    guard(
      {
        method: 'GET',
        headers: { host: `${LAN}:${PORT}`, ...headers },
        socket: { remoteAddress: '192.168.1.99' },
      } as never,
      new URL(`http://${LAN}:${PORT}${path}`),
      { port: PORT, lan: true },
    );

  for (const secret of ['/', '/review', `/progress/${slug}`, '/artifacts/art_x.webm', '/how']) {
    const decision = fakeRemote(secret, { 'x-primer-token': token });
    assert.equal(decision.allow, false, `${secret} must not be reachable from the network`);
  }
});

test("a child's device reaches activities, and only with the key", async () => {
  const { guard } = await import('../src/surface/security.ts');
  const ask = (path: string, headers: Record<string, string> = {}) =>
    guard(
      {
        method: 'GET',
        headers: { host: `${LAN}:${PORT}`, ...headers },
        socket: { remoteAddress: '192.168.1.99' },
      } as never,
      new URL(`http://${LAN}:${PORT}${path}`),
      { port: PORT, lan: true },
    );

  assert.equal(ask(`/k/${slug}`).allow, false, 'no key, no entry');
  assert.equal(ask(`/k/${slug}`).status, 401);
  assert.equal(ask(`/k/${slug}`, { 'x-primer-token': 'wrong' }).allow, false);
  assert.equal(ask(`/k/${slug}`, { 'x-primer-token': token }).allow, true, 'the key opens the activity');
  assert.equal(ask('/runtime.js', { 'x-primer-token': token }).allow, true);
});

test('with --lan off, nothing off-machine is served at all', async () => {
  const { guard } = await import('../src/surface/security.ts');
  const decision = guard(
    {
      method: 'GET',
      headers: { host: `127.0.0.1:${PORT}` },
      socket: { remoteAddress: '192.168.1.99' },
    } as never,
    new URL(`${BASE}/k/${slug}`),
    { port: PORT, lan: false },
  );
  assert.equal(decision.allow, false, 'the default must not be reachable from the network');
});

test('generated activities are served with a policy that stops them phoning home', async () => {
  const res = await fetch(`${BASE}/k/${slug}`);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/, 'an activity may talk to this record and nowhere else');
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('a name containing markup cannot run on the adult page', async () => {
  createLearner({ display_name: `<img src=x onerror="alert(1)">` });
  const html = await (await fetch(`${BASE}/`)).text();
  assert.ok(!html.includes('<img src=x onerror'), 'markup in a name must never be emitted raw');
  assert.ok(html.includes('&lt;img'), 'it should appear escaped, as text');
});

test("a child called O'Brien does not break the approve button", async () => {
  const { planActivity, approve } = await import('../src/record/queue.ts');
  const { saveInterface } = await import('../src/surface/store.ts');
  const obrien = createLearner({ display_name: "Aoife O'Brien" });
  const iface = saveInterface(obrien.id, {
    title: 'Reading',
    html: `<!doctype html><html><body><script>window.primer.observe({skill:'x',correct:1})</script></body></html>`,
  });
  planActivity(obrien.id, { interface_id: iface.id, title: 'Reading', rationale: 'Because.' });

  const html = await (await fetch(`${BASE}/review`)).text();
  // The name travels as data, never spliced into a JS string literal where an
  // apostrophe would end it and silently disable the only control in the product.
  assert.ok(!/decide\('[^']*O'Brien/.test(html), 'the name must not be inlined into JS');
  assert.match(html, /data-name="Aoife O&#39;Brien"/);
  assert.match(html, /data-decide="approve"/);
  void approve;
});

test('the record cannot be flooded through the API', async () => {
  let refused = 0;
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${BASE}/api/interest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ learner_id: learnerId, topic: `flood ${i}` }),
    });
    if (res.status === 429) refused += 1;
  }
  assert.ok(refused > 0, 'a runaway page must eventually be throttled');
});

test('a session id from the query string cannot smuggle markup into the page', async () => {
  const { saveInterface } = await import('../src/surface/store.ts');
  const iface = saveInterface(learnerId, {
    title: 'Probe',
    html: `<!doctype html><html><head></head><body><script>window.primer.observe({skill:'x',correct:1})</script></body></html>`,
  });
  const evil = encodeURIComponent('</script><script>alert(1)</script>');
  const html = await (await fetch(`${BASE}/i/${iface.id}?session=${evil}`)).text();

  assert.ok(!html.includes('</script><script>alert(1)'), 'the injected block must not survive');
  assert.match(html, /"session_id":"ses_[a-z0-9]{16}"/, 'a rejected id is replaced with a real one');
});
