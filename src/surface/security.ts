import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { one, run, now, logEvent } from '../db/index.ts';
import { lanAddresses } from './pwa.ts';

/**
 * What stands between a child's record and the rest of the machine's network.
 *
 * Two threats, and only one of them needs an attacker on your wifi.
 *
 * The first is DNS rebinding: any website a parent browses can point a hostname at
 * 127.0.0.1 and then read this server *same-origin* — the whole record, including
 * audio of the child, off a laptop that never enabled LAN mode at all. The defence
 * is refusing requests whose Host header is not one we recognise, because a
 * rebound request cannot forge it.
 *
 * The second is everything else on the wifi once `--lan` is on. There the answer is
 * a token, split in two: the tablet gets a key that opens activities and writes
 * evidence, and nothing else. The recordings, the progress notes and the approval
 * gate stay on loopback, because the tablet is the device most likely to be lent,
 * lost, or handed to a sibling.
 */

export interface AccessDecision {
  allow: boolean;
  status?: number;
  reason?: string;
}

/* ------------------------------------------------------------------ tokens -- */

function getSetting(key: string): string | undefined {
  return one<{ value: string }>(`SELECT value FROM setting WHERE key = ?`, key)?.value;
}

function setSecret(key: string, value: string): void {
  run(
    `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    now(),
  );
}

/**
 * The key a child's device carries. Created once and kept.
 *
 * One key per install, not per child. A tablet holding it can open any child's
 * activity page on this record, so siblings are not isolated from each other by
 * this token — what it separates is the child surface from the adult one. The
 * recordings, the progress pages, and the approval queue are unreachable from the
 * network with any key at all (see ADULT_ONLY below). Say this plainly wherever
 * the QR code is offered; do not describe it as one child's key.
 */
export function childToken(): string {
  const existing = getSetting('child_token');
  if (existing) return existing;
  const token = randomBytes(16).toString('base64url');
  setSecret('child_token', token);
  logEvent('system', 'create_child_token');
  return token;
}

/** Forget the current key. Any device holding it stops working. */
export function rotateChildToken(): string {
  const token = randomBytes(16).toString('base64url');
  setSecret('child_token', token);
  logEvent('cli', 'rotate_child_token');
  return token;
}

function tokenMatches(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const expected = childToken();
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // Length differences leak nothing useful here, but compare in constant time so
  // the content comparison itself does not.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the token from wherever a device might carry it. */
export function presentedToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers['x-primer-token'];
  if (typeof header === 'string' && header) return header;
  const query = url.searchParams.get('t');
  if (query) return query;
  const cookie = req.headers.cookie ?? '';
  const match = cookie.match(/(?:^|;\s*)primer_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

/* -------------------------------------------------------------------- host -- */

function hostIsKnown(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  // Strip the port; handle bracketed IPv6.
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const declaredPort = hostHeader.match(/:(\d+)$/)?.[1];
  if (declaredPort && Number(declaredPort) !== port) return false;

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  return lanAddresses().includes(host);
}

/** Did this request arrive on the loopback interface? */
export function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/* ------------------------------------------------------------------ policy -- */

/**
 * Paths a child's device may reach. Everything else is for the adult, on loopback.
 *
 * `/child/` is the old form of the child's URL and now only redirects to `/k/`.
 * It is here because a link that was bookmarked or written down should keep
 * working; without it the redirect is never reached and a tablet gets a bare 404.
 */
const CHILD_PATHS = [
  /^\/k\//,
  /^\/i\//,
  /^\/child\//,
  /^\/runtime\.js$/,
  /^\/sw\.js$/,
  /^\/api\//,
  /^\/health$/,
];

/** Paths that must never leave this machine, whatever token is presented. */
const ADULT_ONLY = [/^\/$/, /^\/review/, /^\/progress\//, /^\/artifacts\//, /^\/how$/];

export interface GuardOptions {
  port: number;
  lan: boolean;
}

export function guard(req: IncomingMessage, url: URL, opts: GuardOptions): AccessDecision {
  const path = url.pathname;

  // 1. Host. Blocks DNS rebinding even when we are bound to loopback only.
  if (!hostIsKnown(req.headers.host, opts.port)) {
    return {
      allow: false,
      status: 403,
      reason: `unrecognised Host header "${req.headers.host ?? ''}"`,
    };
  }

  // 2. Cross-site writes. A form on another page must not be able to post here.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      return { allow: false, status: 403, reason: `cross-site ${req.method}` };
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin) {
      const expected = new Set(
        [`http://localhost:${opts.port}`, `http://127.0.0.1:${opts.port}`].concat(
          lanAddresses().map((a) => `http://${a}:${opts.port}`),
        ),
      );
      if (!expected.has(origin)) {
        return { allow: false, status: 403, reason: `cross-origin ${req.method} from ${origin}` };
      }
    }
  }

  // 3. Loopback needs nothing more. A parent on this machine is the trusted case.
  if (isLoopback(req)) return { allow: true };

  // 4. Off-machine: only when LAN was explicitly asked for, only child paths,
  //    only with the token.
  if (!opts.lan) return { allow: false, status: 404, reason: 'off-machine request, --lan not enabled' };

  if (ADULT_ONLY.some((re) => re.test(path)) || !CHILD_PATHS.some((re) => re.test(path))) {
    // The recordings, the notes and the approval gate stay on this machine.
    return { allow: false, status: 404, reason: `adult-only path ${path} requested from the network` };
  }

  if (!tokenMatches(presentedToken(req, url))) {
    return { allow: false, status: 401, reason: `missing or wrong token for ${path}` };
  }

  return { allow: true };
}

/* ---------------------------------------------------------------- headers -- */

/**
 * The activity is code an LLM wrote, running on the same origin as the record.
 * Without this it can fetch `/progress/emma`, read the child's misconceptions and
 * the audio of them reading, and post it anywhere. With it, the page can talk to
 * this server and nowhere else — which is all a self-contained activity ever needed.
 */
export const ACTIVITY_CSP =
  "default-src 'none'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "media-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "manifest-src 'self'; " +
  "form-action 'none'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'";

export const ADULT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src 'self' data:; media-src 'self'; connect-src 'self'; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

export function securityHeaders(csp: string): Record<string, string> {
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // A child's record has no business in a search index or another site's frame.
    'x-frame-options': 'DENY',
  };
}

/* ------------------------------------------------------------- rate limits -- */

const buckets = new Map<string, { tokens: number; last: number }>();

/**
 * A crude token bucket. Not protection against a determined attacker — it is there
 * so one runaway generated page cannot fill the disk 25MB at a time, or flood the
 * record with rows nothing can delete.
 */
export function withinRate(key: string, perMinute: number): boolean {
  const at = Date.now();
  const bucket = buckets.get(key) ?? { tokens: perMinute, last: at };
  const refill = ((at - bucket.last) / 60_000) * perMinute;
  bucket.tokens = Math.min(perMinute, bucket.tokens + refill);
  bucket.last = at;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

export function rateKey(req: IncomingMessage, bucketName: string): string {
  return `${bucketName}:${req.socket.remoteAddress ?? 'unknown'}`;
}

/** JSON is inlined into a <script>; `</script>` inside a string would end it early. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    // Line and paragraph separators end a statement to a JS parser but not to JSON.
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

export const SESSION_ID = /^ses_[a-z0-9]{16}$/;
