import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { primerHome } from '../db/index.ts';
import { getInterface, renderInterface, runtimeSource, scoreInterface } from './store.ts';
import { resolveLearner, noteInterest } from '../record/learners.ts';
import {
  nextReady,
  markDelivered,
  completeByInterface,
  pendingReview,
  approve,
  reject,
} from '../record/queue.ts';
import { homePage, reviewPage, progressPage, nothingWaitingPage, howPage } from './pages.ts';
import { saveArtifact, describeArtifact, markReviewed } from '../record/artifacts.ts';
import { settings, setDeviceCapabilities } from '../agent/config.ts';
import {
  SERVICE_WORKER,
  appHead,
  iconSvg,
  iconPng,
  learnerBySlug,
  manifestFor,
  slugFor,
} from './pwa.ts';
import type { Learner } from '../domain/types.ts';
import {
  guard,
  securityHeaders,
  ACTIVITY_CSP,
  ADULT_CSP,
  withinRate,
  rateKey,
  childToken,
  SESSION_ID,
} from './security.ts';
import { logEvent, one } from '../db/index.ts';

const HTML = (csp: string) => ({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  ...securityHeaders(csp),
});

/**
 * Give a page the trappings of an installed app: home-screen identity, no browser
 * chrome, offline fallback. The activity's own markup is untouched — this only
 * adds to its <head>.
 */
function withAppHead(html: string, learner: Learner, slug: string): string {
  const head = appHead(learner, slug);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`);
  if (/<!doctype[^>]*>/i.test(html)) return html.replace(/<!doctype[^>]*>/i, (m) => `${m}\n${head}`);
  return head + html;
}
import {
  recordObservations,
  noteAffect,
  noteMisconception,
  endSession,
  startSession,
  resumeOrStartSession,
  type ObservationInput,
} from '../record/observations.ts';

const DEFAULT_PORT = Number(process.env.PRIMER_PORT ?? 7333);

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Raw bytes, for a recording. Capped so a runaway page cannot fill the disk. */
async function readBinary(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 25_000_000) throw new Error('recording too large (25MB limit)');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 5_000_000) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
};

/**
 * Localhost-only surface. Serves generated interfaces and takes their telemetry.
 *
 * This is deliberately not an app. It is a picture frame: it holds whatever the
 * tutor drew today and carries what happens inside it back to the record.
 */
export interface SurfaceOptions {
  /**
   * Bind to every interface so a tablet on the same wifi can reach it.
   *
   * Off by default, and it should stay off unless someone asks: the record has no
   * login, so anything on the network can read it. On a home network that is a
   * reasonable trade for being able to hand a child a tablet. On a café network it
   * is not.
   */
  lan?: boolean;
}

export function createSurfaceServer(port = DEFAULT_PORT, opts: SurfaceOptions = {}) {
  const host = opts.lan ? '0.0.0.0' : '127.0.0.1';
  const origin = `http://127.0.0.1:${port}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname;

    try {
      // Everything is checked before anything is served: Host (so a rebound
      // hostname cannot read the record), cross-site writes, and — off this
      // machine — the child token and the child-only path list.
      const decision = guard(req, url, { port, lan: Boolean(opts.lan) });
      if (!decision.allow) {
        logEvent('surface', 'refused_request', path, {
          reason: decision.reason,
          from: req.socket.remoteAddress,
        });
        json(res, decision.status ?? 403, { error: 'not available' });
        return;
      }

      if (req.method === 'POST' && path.startsWith('/api/')) {
        // One runaway page must not be able to fill the disk or flood the record.
        const limit = path === '/api/artifact' ? 20 : 240;
        if (!withinRate(rateKey(req, path), limit)) {
          json(res, 429, { error: 'too many requests' });
          return;
        }
      }

      if (req.method === 'GET' && path === '/runtime.js') {
        const src = runtimeSource();
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        res.end(src);
        return;
      }

      if (req.method === 'GET' && path === '/health') {
        json(res, 200, { ok: true, port });
        return;
      }

      if (req.method === 'GET' && path === '/sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        res.end(SERVICE_WORKER);
        return;
      }

      // /k/<slug> — the child's app.
      //
      // One address, short enough to type on a tablet, that never changes. It is
      // installable to a home screen under their own name and colour, and what is
      // inside was written for them. No menu, no library, and no way to reach
      // another child from here.
      if (req.method === 'GET' && path.startsWith('/k/')) {
        const parts = path.split('/');
        const learner = learnerBySlug(decodeURIComponent(parts[2] ?? ''));
        if (!learner) {
          json(res, 404, { error: 'no such child' });
          return;
        }
        const slug = slugFor(learner);
        const sub = parts[3];

        if (sub === 'manifest.webmanifest') {
          res.writeHead(200, {
            'content-type': 'application/manifest+json',
            'cache-control': 'no-store',
          });
          res.end(manifestFor(learner));
          return;
        }
        if (sub === 'icon.svg') {
          res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
          res.end(iconSvg(learner));
          return;
        }
        const pngMatch = sub?.match(/^icon-(\d{2,4})\.png$/);
        if (pngMatch) {
          const size = Math.min(1024, Math.max(16, Number(pngMatch[1])));
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
          res.end(iconPng(learner, size));
          return;
        }

        const activity = nextReady(learner.id);
        if (!activity?.interface_id) {
          res.writeHead(200, HTML(ACTIVITY_CSP));
          res.end(withAppHead(nothingWaitingPage(learner.display_name), learner, slug));
          return;
        }

        const iface = getInterface(activity.interface_id);
        if (!iface) {
          json(res, 500, { error: 'the queued activity has lost its interface' });
          return;
        }
        // Only stamps a delivery the first time; reopening to resume does not
        // restart the clock or hide it from a later sweep.
        markDelivered(activity.id);
        // Reuse the session if this is a reopen. Creating one per GET means a link
        // preview, a port scan, or a child refreshing litters the record with
        // phantom sessions and wrecks the "minutes practised" figure a parent reads.
        const session = resumeOrStartSession(learner.id, iface.id);
        // Served in place rather than redirected, so the installed app always opens
        // on whatever is waiting today instead of pinning one finished activity.
        const html = renderInterface(iface, {
          learner_id: learner.id,
          session_id: session.id,
          api: '',
        });
        res.writeHead(200, HTML(ACTIVITY_CSP));
        res.end(withAppHead(html, learner, slug));
        return;
      }

      // The old id-based path still works; it just moves you to the short one.
      if (req.method === 'GET' && path.startsWith('/child/')) {
        const ref = decodeURIComponent(path.slice('/child/'.length));
        let learner;
        try {
          learner = resolveLearner(ref);
        } catch {
          json(res, 404, { error: 'no such learner' });
          return;
        }
        res.writeHead(302, { location: `/k/${slugFor(learner)}`, 'cache-control': 'no-store' });
        res.end();
        return;
      }

      // GET /i/<interface_id>?session=<id>  — open a generated interface
      if (req.method === 'GET' && path.startsWith('/i/')) {
        const ifaceId = decodeURIComponent(path.slice(3));
        const iface = getInterface(ifaceId);
        if (!iface) {
          json(res, 404, { error: `no interface ${ifaceId}` });
          return;
        }
        // A caller-supplied session id is inlined into the page, so it must look
        // like one of ours and actually exist — otherwise it is just a string an
        // outsider chose, ending up inside a <script>.
        const requested = url.searchParams.get('session');
        const valid =
          requested &&
          SESSION_ID.test(requested) &&
          one<{ id: string }>(`SELECT id FROM session WHERE id = ?`, requested);
        const sessionId = valid
          ? requested
          : startSession(iface.learner_id, { mode: 'practice', interface_id: iface.id }).id;
        const html = renderInterface(iface, {
          learner_id: iface.learner_id,
          session_id: sessionId,
          api: '',
        });
        res.writeHead(200, HTML(ACTIVITY_CSP));
        res.end(html);
        return;
      }

      // Child's own work products: audio, photos, drawings.
      if (req.method === 'GET' && path.startsWith('/artifacts/')) {
        const name = decodeURIComponent(path.slice('/artifacts/'.length));
        if (name.includes('..') || name.includes('/') || name.includes('\\')) {
          json(res, 400, { error: 'bad path' });
          return;
        }
        const file = join(primerHome(), 'artifacts', name);
        if (!existsSync(file)) {
          json(res, 404, { error: 'not found' });
          return;
        }
        res.writeHead(200, { 'content-type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream' });
        res.end(readFileSync(file));
        return;
      }

      if (req.method === 'POST' && path === '/api/observe') {
        const body = await readBody(req);
        const obs: ObservationInput[] = (body.observations ?? []).map((o: ObservationInput) => ({
          ...o,
          session_id: o.session_id ?? body.session_id ?? null,
          source: o.source ?? body.interface_id ?? 'interface',
        }));
        const results = recordObservations(body.learner_id, obs, 'interface');
        json(res, 200, { recorded: results.length, results });
        return;
      }

      // A generated interface posts the child's voice here. Raw bytes in the body,
      // metadata in the query string — no multipart parser, no dependency.
      if (req.method === 'POST' && path === '/api/artifact') {
        if (!settings().audio_capture) {
          json(res, 403, { error: 'audio capture is off; an adult must enable it' });
          return;
        }
        const learnerId = url.searchParams.get('learner_id');
        if (!learnerId) {
          json(res, 400, { error: 'learner_id is required' });
          return;
        }
        const learner = resolveLearner(learnerId);
        const data = await readBinary(req);
        if (!data.length) {
          json(res, 400, { error: 'empty body' });
          return;
        }
        const skills = (url.searchParams.get('skills') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const artifact = saveArtifact(learner.id, {
          kind: (url.searchParams.get('kind') as 'audio') ?? 'audio',
          data,
          mimeType: (req.headers['content-type'] ?? 'audio/webm').split(';')[0]!.trim(),
          session_id: url.searchParams.get('session_id') || null,
          prompt: url.searchParams.get('prompt') || null,
          duration_ms: Number(url.searchParams.get('duration_ms')) || null,
          skill_ids: skills,
        });
        json(res, 200, describeArtifact(artifact));
        return;
      }

      if (req.method === 'POST' && /^\/api\/artifact\/[^/]+\/reviewed$/.test(path)) {
        markReviewed(path.split('/')[3]!, 'parent');
        json(res, 200, { ok: true });
        return;
      }

      // A device telling us what it cannot do. Recorded so a parent can be shown
      // the reason instead of watching a setting appear to have no effect.
      if (req.method === 'POST' && path === '/api/device') {
        const body = await readBody(req);
        try {
          const learner = resolveLearner(body.learner_id);
          setDeviceCapabilities(learner.id, body.capabilities ?? {}, body.note);
        } catch {
          /* unknown learner — nothing to record against */
        }
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && path === '/api/affect') {
        const body = await readBody(req);
        noteAffect(body.learner_id, body.signal, {
          intensity: body.intensity,
          evidence: body.evidence,
          session_id: body.session_id,
        });
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && path === '/api/interest') {
        const body = await readBody(req);
        const saved = noteInterest(body.learner_id, body.topic, {
          weight: body.weight,
          source: body.source,
          note: body.note,
        });
        json(res, 200, { topic: saved.topic, weight: saved.weight });
        return;
      }

      if (req.method === 'POST' && path === '/api/misconception') {
        const body = await readBody(req);
        json(res, 200, noteMisconception(body.learner_id, body.pattern, {
          skill_id: body.skill_id,
          example: body.example,
        }));
        return;
      }

      if (req.method === 'POST' && path === '/api/session/end') {
        const body = await readBody(req);
        if (body.session_id) {
          endSession(body.session_id, { summary: body.summary, energy: body.energy });
        }
        let score: number | null = null;
        if (body.interface_id) {
          score = scoreInterface(body.interface_id, body.outcome_note);
          completeByInterface(body.interface_id);
        }
        json(res, 200, { ok: true, outcome_score: score });
        return;
      }

      // The adult review gate. Plain on purpose — this is not a product surface,
      // it is the place a parent decides whether a generated activity reaches
      // their child. Nothing the tutor queues gets past here without a click.
      if (req.method === 'GET' && path === '/how') {
        res.writeHead(200, HTML(ADULT_CSP));
        res.end(howPage());
        return;
      }

      if (req.method === 'GET' && path === '/review') {
        res.writeHead(200, HTML(ADULT_CSP));
        res.end(reviewPage(pendingReview()));
        return;
      }

      if (req.method === 'POST' && path === '/review/decide') {
        const body = await readBody(req);
        const decided =
          body.decision === 'approve'
            ? approve(body.activity_id, 'parent', body.note)
            : reject(body.activity_id, 'parent', body.note);
        json(res, 200, {
          ok: true,
          status: decided?.status,
          // So the page can say where it went, rather than just that something happened.
          child_url: decided ? `/child/${decided.learner_id}` : null,
        });
        return;
      }

      if (req.method === 'GET' && path.startsWith('/progress/')) {
        const ref = decodeURIComponent(path.slice('/progress/'.length));
        // Links elsewhere use the short slug, so try that first. Resolving only by
        // id or display name broke this page for every child whose name is more
        // than one word.
        let learner = learnerBySlug(ref);
        if (!learner) {
          try {
            learner = resolveLearner(ref);
          } catch {
            json(res, 404, { error: 'no such learner' });
            return;
          }
        }
        res.writeHead(200, HTML(ADULT_CSP));
        res.end(progressPage(learner.id));
        return;
      }

      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, HTML(ADULT_CSP));
        res.end(homePage());
        return;
      }

      json(res, 404, { error: 'not found', path });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  return {
    server,
    port,
    origin,
    urlFor: (ifaceId: string, sessionId?: string) =>
      `${origin}/i/${ifaceId}${sessionId ? `?session=${sessionId}` : ''}`,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
