import { networkInterfaces } from 'node:os';
import { all, one } from '../db/index.ts';
import type { Learner } from '../domain/types.ts';
import { letterIconPng, parseHsl } from './icon.ts';

/**
 * Each child gets their own app.
 *
 * Not a themed skin over a shared product — a separate installed thing with their
 * name on the home screen, their colour, their letter. When they open it, what is
 * inside was written for them and for nobody else. The shell is the only part that
 * repeats, and the shell is deliberately almost nothing: no menu, no library, no
 * settings, no way to browse to another child.
 *
 * The Primer was a book. This is the closest a browser gets to handing a child an
 * object that is theirs.
 */

/** A short, typable path for a child. `/k/ada` rather than `/child/lrn_9f3c...`. */
export function slugFor(learner: Pick<Learner, 'id' | 'display_name'>): string {
  const base = learner.display_name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!base) return learner.id.slice(4, 10);

  // Two children called Sam get `sam` and `sam-2`, assigned by creation order so a
  // child's link never changes underneath them.
  const sharing = all<{ id: string }>(
    `SELECT id FROM learner WHERE archived_at IS NULL AND lower(display_name) = lower(?)
      ORDER BY created_at`,
    learner.display_name,
  );
  const index = sharing.findIndex((row) => row.id === learner.id);
  return index > 0 ? `${base}-${index + 1}` : base;
}

export function learnerBySlug(slug: string): Learner | undefined {
  const wanted = slug.toLowerCase();
  return all<Learner>(`SELECT * FROM learner WHERE archived_at IS NULL ORDER BY created_at`).find(
    (l) => slugFor(l) === wanted,
  );
}

/** A stable colour per child, derived from their id so it never shifts. */
export function colorFor(learnerId: string): { bg: string; ink: string } {
  let hash = 0;
  for (let i = 0; i < learnerId.length; i++) hash = (hash * 31 + learnerId.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return { bg: `hsl(${hue} 62% 46%)`, ink: '#fffdf8' };
}

/** Their initial, drawn. No image files to ship, and it scales to any icon size. */
export function iconSvg(learner: Learner): string {
  const { bg, ink } = colorFor(learner.id);
  const initial = (learner.display_name.trim()[0] ?? '?').toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="${bg}"/>
  <text x="256" y="256" fill="${ink}" font-family="Georgia,serif" font-size="280"
        font-weight="600" text-anchor="middle" dominant-baseline="central">${escapeXml(initial)}</text>
</svg>`;
}

/** The same tile as `iconSvg`, as a PNG at whatever size the platform asked for. */
export function iconPng(learner: Learner, size: number): Buffer {
  const { bg } = colorFor(learner.id);
  const initial = (learner.display_name.trim()[0] ?? '?').toUpperCase();
  return letterIconPng(initial, { size, background: parseHsl(bg) });
}

export function manifestFor(learner: Learner): string {
  const slug = slugFor(learner);
  const { bg } = colorFor(learner.id);
  return JSON.stringify(
    {
      name: `${learner.display_name}'s Primer`,
      short_name: learner.display_name,
      description: `Made for ${learner.display_name}.`,
      // Opening the installed app always lands on whatever is waiting today, never
      // on a specific activity that has since been finished.
      start_url: `/k/${slug}`,
      scope: `/`,
      display: 'standalone',
      orientation: 'any',
      background_color: bg,
      theme_color: bg,
      icons: [
        // PNG first and at real sizes: iOS ignores SVG icons entirely and falls
        // back to screenshotting the page, which is how a child's tile ends up
        // showing a picture of their own homework instead of their initial.
        { src: `/k/${slug}/icon-180.png`, sizes: '180x180', type: 'image/png', purpose: 'any' },
        { src: `/k/${slug}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: `/k/${slug}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        { src: `/k/${slug}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ],
    },
    null,
    2,
  );
}

/**
 * Injected into every activity so the page behaves like an app rather than a
 * document: home-screen installable, no browser chrome, and the last activity
 * still opens when the wifi is down.
 */
export function appHead(learner: Learner, slug: string): string {
  const { bg } = colorFor(learner.id);
  return `<link rel="manifest" href="/k/${slug}/manifest.webmanifest">
<meta name="theme-color" content="${bg}">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${escapeXml(learner.display_name)}">
<link rel="apple-touch-icon" sizes="180x180" href="/k/${slug}/icon-180.png">
<style>
  html,body{margin:0;padding:0;overscroll-behavior:none;-webkit-tap-highlight-color:transparent}
  body{padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
  /* A child dragging a finger across a word should not select it or bounce the page. */
  *{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
  input,textarea{-webkit-user-select:text;user-select:text}
</style>
<script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
</script>`;
}

/**
 * A deliberately small service worker: cache the activity a child is in the middle
 * of, so a dropped connection does not end the session. It does not cache the
 * queue, because what is waiting must always come from the record.
 */
export const SERVICE_WORKER = `
const CACHE = 'primer-v1';

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Evidence must reach the record, never a cache.
  if (url.pathname.startsWith('/api/')) return;

  // An activity, once opened, should survive the wifi dropping mid-session.
  if (url.pathname.startsWith('/i/') || url.pathname.startsWith('/k/')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request).then((hit) => hit || offline())),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).catch(offline)),
  );
});

function offline() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font:22px/1.7 Verdana,sans-serif;background:#f7f1e6;color:#241c15;display:flex;' +
      'align-items:center;justify-content:center;min-height:100vh;margin:0;padding:2rem;text-align:center}</style>' +
      '<p>No connection right now.<br>Try again in a bit.</p>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
`;

/* ---------------------------------------------------------------- network -- */

/**
 * Addresses a tablet on the same wifi could actually reach.
 *
 * Filtered rather than merely sorted: a machine with no DHCP lease still reports a
 * 169.254 link-local address, and putting that in front of a parent sends them off
 * to type a number that can never work.
 */
export function lanAddresses(): string[] {
  const candidates: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (address.address.startsWith('169.254.')) continue; // no DHCP lease; unreachable
      candidates.push(address.address);
    }
  }

  // Home wifi first, then other private ranges, then anything else.
  const rank = (ip: string) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  return candidates.sort((a, b) => rank(a) - rank(b));
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function learnerById(learnerId: string): Learner | undefined {
  return one<Learner>(`SELECT * FROM learner WHERE id = ?`, learnerId);
}
