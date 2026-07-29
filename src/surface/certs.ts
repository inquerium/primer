/**
 * Local CA + leaf certificate for LAN HTTPS.
 *
 * Browsers withhold the microphone and service workers outside a secure context.
 * On a tablet that means HTTPS — and for a private LAN IP that means a certificate
 * the tablet has been told to trust. We mint a small private CA once, sign a leaf
 * that covers localhost and the current wifi addresses, and leave the CA as a
 * downloadable .cer for the parent to install on each tablet.
 *
 * Nothing here needs openssl, mkcert, or a toolchain. Certs live under
 * primerHome()/certs/ so they survive restarts and are not baked into the binary.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import selfsigned from 'selfsigned';
import { primerHome } from '../db/index.ts';
import { lanAddresses } from './pwa.ts';

export interface TlsMaterial {
  /** PEM leaf certificate (server). */
  cert: string;
  /** PEM private key for the leaf. */
  key: string;
  /** PEM of the primer CA — what a tablet must trust. */
  caPem: string;
  /** DER bytes of the CA, for `/ca.cer` downloads (iOS/Android prefer this). */
  caDer: Buffer;
  /** Hostnames / IPs the leaf covers. */
  hosts: string[];
}

function certsDir(): string {
  return join(primerHome(), 'certs');
}

function paths() {
  const dir = certsDir();
  return {
    dir,
    caKey: join(dir, 'ca-key.pem'),
    caCert: join(dir, 'ca.pem'),
    leafKey: join(dir, 'server-key.pem'),
    leafCert: join(dir, 'server.pem'),
    hosts: join(dir, 'hosts.json'),
  };
}

function wantedHosts(): string[] {
  const hosts = new Set<string>(['localhost', '127.0.0.1', '::1']);
  for (const a of lanAddresses()) hosts.add(a);
  return [...hosts].sort();
}

function sameHosts(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function altNames(hosts: string[]) {
  return hosts.map((h) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')
      ? { type: 7 as const, ip: h }
      : { type: 2 as const, value: h },
  );
}

function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

async function mintCa(): Promise<{ key: string; cert: string }> {
  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 10);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Primer Local' }], {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}

async function mintLeaf(
  ca: { key: string; cert: string },
  hosts: string[],
): Promise<{ key: string; cert: string }> {
  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 2);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'primer' }], {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    ca: { key: ca.key, cert: ca.cert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
      },
      {
        name: 'subjectAltName',
        altNames: altNames(hosts),
      },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}

function leafStillValid(certPem: string, hosts: string[]): boolean {
  try {
    const x = new X509Certificate(certPem);
    const now = Date.now();
    if (now < Date.parse(x.validFrom) || now > Date.parse(x.validTo)) return false;
    // Re-issue when the LAN address set drifts (DHCP). Comparing the stored host
    // list is enough — we rewrite hosts.json whenever we mint.
    void hosts;
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a CA and a leaf covering the current LAN addresses exist on disk.
 * Regenerates the leaf when wifi addresses change; keeps the CA stable so a
 * tablet that already trusts it does not need to reinstall.
 */
export async function ensureTlsMaterial(): Promise<TlsMaterial> {
  const p = paths();
  mkdirSync(p.dir, { recursive: true });
  const hosts = wantedHosts();

  let caKey: string;
  let caCert: string;
  if (existsSync(p.caKey) && existsSync(p.caCert)) {
    caKey = readFileSync(p.caKey, 'utf8');
    caCert = readFileSync(p.caCert, 'utf8');
  } else {
    const ca = await mintCa();
    caKey = ca.key;
    caCert = ca.cert;
    writeFileSync(p.caKey, caKey, { mode: 0o600 });
    writeFileSync(p.caCert, caCert, { mode: 0o644 });
  }

  let leafKey: string | undefined;
  let leafCert: string | undefined;
  let storedHosts: string[] = [];
  if (existsSync(p.hosts)) {
    try {
      storedHosts = JSON.parse(readFileSync(p.hosts, 'utf8')) as string[];
    } catch {
      storedHosts = [];
    }
  }

  if (
    existsSync(p.leafKey) &&
    existsSync(p.leafCert) &&
    sameHosts(storedHosts, hosts)
  ) {
    leafKey = readFileSync(p.leafKey, 'utf8');
    leafCert = readFileSync(p.leafCert, 'utf8');
    if (!leafStillValid(leafCert, hosts)) {
      leafKey = undefined;
      leafCert = undefined;
    }
  }

  if (!leafKey || !leafCert) {
    const leaf = await mintLeaf({ key: caKey, cert: caCert }, hosts);
    leafKey = leaf.key;
    leafCert = leaf.cert;
    writeFileSync(p.leafKey, leafKey, { mode: 0o600 });
    writeFileSync(p.leafCert, leafCert, { mode: 0o644 });
    writeFileSync(p.hosts, JSON.stringify(hosts));
  }

  return {
    cert: leafCert,
    key: leafKey,
    caPem: caCert,
    caDer: pemToDer(caCert),
    hosts,
  };
}

/** Path to the CA PEM on disk — useful for CLI hints. */
export function caCertPath(): string {
  return paths().caCert;
}

/** Forget generated certs (tests). The next ensureTlsMaterial() remints. */
export function resetTlsMaterial(): void {
  const p = paths();
  for (const f of [p.caKey, p.caCert, p.leafKey, p.leafCert, p.hosts]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}
