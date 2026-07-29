import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';

const home = mkdtempSync(join(tmpdir(), 'primer-tls-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createSurfaceServer } = await import('../src/surface/server.ts');
const { ensureTlsMaterial, resetTlsMaterial, caCertPath } = await import('../src/surface/certs.ts');
const { lanAddresses } = await import('../src/surface/pwa.ts');

const PORT = 7788;

before(() => {
  db();
  loadCurriculum();
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('a private CA and leaf cover localhost and the current wifi addresses', async () => {
  resetTlsMaterial();
  const material = await ensureTlsMaterial();
  assert.ok(material.caPem.includes('BEGIN CERTIFICATE'));
  assert.ok(material.cert.includes('BEGIN CERTIFICATE'));
  assert.ok(material.key.includes('PRIVATE KEY'));
  assert.ok(material.caDer.length > 100);

  const leaf = new X509Certificate(material.cert);
  const hosts = material.hosts;
  assert.ok(hosts.includes('127.0.0.1'));
  assert.ok(hosts.includes('localhost'));
  for (const a of lanAddresses()) assert.ok(hosts.includes(a), `missing SAN for ${a}`);

  // Stable CA path for parents who want to install from disk.
  assert.match(caCertPath().replace(/\\/g, '/'), /\/ca\.pem$/);
  assert.ok(leaf.subject.includes('primer') || leaf.subject.includes('CN'));
});

test('HTTPS surface serves activities and exposes the CA over plain HTTP', async () => {
  resetTlsMaterial();
  const surface = await createSurfaceServer(PORT, { lan: true, https: true });
  await surface.listen();

  try {
    assert.equal(surface.origin, `https://127.0.0.1:${PORT}`);
    assert.equal(surface.caPort, PORT + 1);
    assert.equal(process.env.PRIMER_TLS, '1');

    // Fetch the CA from the companion HTTP port without any trust dance.
    const caBody = await new Promise<Buffer>((resolve, reject) => {
      httpRequest(
        { host: '127.0.0.1', port: surface.caPort, path: '/ca.cer', method: 'GET' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        },
      )
        .on('error', reject)
        .end();
    });
    assert.ok(caBody.length > 100);
    // DER certificates start with SEQUENCE tag 0x30.
    assert.equal(caBody[0], 0x30);

    // HTTPS /health with the minted CA as trust root.
    const material = await ensureTlsMaterial();
    const health = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      httpsRequest(
        {
          host: '127.0.0.1',
          port: PORT,
          path: '/health',
          method: 'GET',
          ca: material.caPem,
          servername: 'localhost',
          headers: { host: `127.0.0.1:${PORT}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      )
        .on('error', reject)
        .end();
    });
    assert.equal(health.status, 200);
    assert.match(health.body, /ok|primer/i);

    // Companion must not serve the record.
    const blocked = await new Promise<number>((resolve, reject) => {
      httpRequest(
        { host: '127.0.0.1', port: surface.caPort, path: '/review', method: 'GET' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      )
        .on('error', reject)
        .end();
    });
    assert.equal(blocked, 404);
  } finally {
    await surface.close();
    delete process.env.PRIMER_TLS;
  }
});
