/**
 * The parent app — one screen, no terminal.
 *
 * Primer's brain is a record + MCP + tutor. Parents should never have to know
 * that. This page is the whole product for them: add a child, ask Claude to
 * prepare work, approve it, hand the tablet over. The student path stays /k/…
 * and is unchanged.
 */
import { listLearners, createLearner, ageYears } from '../record/learners.ts';
import { pendingReview, readyCount } from '../record/queue.ts';
import { slugFor, colorFor, lanAddresses } from './pwa.ts';
import { childToken } from './security.ts';
import { qrSvg } from './qr.ts';
import { transportStatus } from '../agent/acp.ts';
import { claudeBinary } from '../agent/claude-code.ts';
import { escapeHtml } from './pages.ts';
import { existsSync } from 'node:fs';

export interface AppChild {
  id: string;
  name: string;
  slug: string;
  age: number | null;
  color: string;
  ready: number;
  review: number;
  tabletUrl: string;
  qr: string;
}

export interface AppStatus {
  children: AppChild[];
  waitingReview: number;
  lan: boolean;
  https: boolean;
  origin: string;
  caUrl: string | null;
  transport: ReturnType<typeof transportStatus>;
  claude: { binary: string; found: boolean };
}

export function appStatus(opts: {
  port: number;
  lan: boolean;
  https: boolean;
  caPort?: number;
}): AppStatus {
  const scheme = opts.https ? 'https' : 'http';
  const addresses = lanAddresses();
  const host = addresses[0] ?? '127.0.0.1';
  const token = childToken();

  const children = listLearners().map((child) => {
    const slug = slugFor(child);
    const { bg } = colorFor(child.id);
    const tabletUrl = opts.lan
      ? `${scheme}://${host}:${opts.port}/k/${slug}?t=${token}`
      : `http://127.0.0.1:${opts.port}/k/${slug}?t=${token}`;
    let qr = '';
    try {
      qr = qrSvg(tabletUrl, { size: 140 });
    } catch {
      qr = '';
    }
    return {
      id: child.id,
      name: child.display_name,
      slug,
      age: ageYears(child),
      color: bg,
      ready: readyCount(child.id),
      review: pendingReview(child.id).length,
      tabletUrl,
      qr,
    };
  });

  const bin = claudeBinary();
  return {
    children,
    waitingReview: pendingReview().length,
    lan: opts.lan,
    https: opts.https,
    origin: `${scheme}://127.0.0.1:${opts.port}`,
    caUrl:
      opts.https && opts.caPort && addresses[0]
        ? `http://${addresses[0]}:${opts.caPort}/ca.cer`
        : opts.https && opts.caPort
          ? `http://127.0.0.1:${opts.caPort}/ca.cer`
          : null,
    transport: transportStatus(),
    claude: { binary: bin, found: existsSync(bin) || !bin.includes('/') && !bin.includes('\\') },
  };
}

export function addChildFromApp(name: string, birth?: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Name is required');
  if (trimmed.length > 80) throw new Error('Name is too long');
  return createLearner({ display_name: trimmed, birth_date: birth || undefined });
}

/**
 * Full parent shell. Self-contained HTML + CSS + JS. Posts to /api/app/* on
 * this same origin; adult-only (loopback).
 */
export function parentAppPage(status: AppStatus): string {
  const data = JSON.stringify(status).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>primer</title>
<style>
  :root {
    --ink: #1a2421;
    --dim: #5c6b66;
    --paper: #f3f6f4;
    --card: #ffffff;
    --line: #d5ddd8;
    --accent: #1f6f5b;
    --accent-ink: #0f3d32;
    --warn: #9a4d1c;
    --warn-bg: #fbf0e6;
    --ok: #1f6f5b;
    --shadow: 0 10px 30px rgba(26, 36, 33, 0.06);
  }
  * { box-sizing: border-box }
  html, body { margin: 0; min-height: 100% }
  body {
    font-family: "Segoe UI", "Avenir Next", "Helvetica Neue", sans-serif;
    color: var(--ink);
    background:
      radial-gradient(1200px 600px at 10% -10%, #dceee6 0%, transparent 55%),
      radial-gradient(900px 500px at 100% 0%, #e8f0ea 0%, transparent 50%),
      var(--paper);
    padding: 2rem 1.25rem 4rem;
  }
  .wrap { max-width: 42rem; margin: 0 auto }
  header { margin-bottom: 1.75rem }
  .brand {
    font-size: clamp(2.4rem, 6vw, 3.2rem);
    font-weight: 700;
    letter-spacing: -0.04em;
    margin: 0;
    color: var(--accent-ink);
  }
  .tag { color: var(--dim); margin: .35rem 0 0; font-size: 1.05rem; max-width: 28rem }
  .panel {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 1.25rem 1.35rem;
    margin: 1rem 0;
    box-shadow: var(--shadow);
  }
  .panel h2 { margin: 0 0 .75rem; font-size: 1.05rem }
  .row { display: flex; gap: .75rem; flex-wrap: wrap; align-items: center }
  .grow { flex: 1 1 12rem }
  input[type=text], input[type=date] {
    width: 100%;
    border: 1.5px solid var(--line);
    border-radius: 12px;
    padding: .7rem .9rem;
    font: inherit;
    background: #fff;
  }
  input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 40%, white); border-color: var(--accent) }
  button, .btn {
    appearance: none; border: 0; cursor: pointer;
    background: var(--accent); color: #fff;
    font: inherit; font-weight: 600;
    border-radius: 12px; padding: .7rem 1.1rem;
  }
  button.secondary, .btn.secondary {
    background: transparent; color: var(--accent-ink);
    border: 1.5px solid var(--line);
  }
  button:disabled { opacity: .55; cursor: wait }
  button.ghost { background: transparent; color: var(--dim); padding: .4rem .6rem; font-weight: 500 }
  .child {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 1rem;
    align-items: start;
    padding: 1rem 0;
    border-top: 1px solid var(--line);
  }
  .child:first-of-type { border-top: 0; padding-top: 0 }
  .avatar {
    width: 3rem; height: 3rem; border-radius: 14px;
    display: grid; place-items: center;
    color: #fff; font-weight: 700; font-size: 1.2rem;
  }
  .name { font-size: 1.2rem; font-weight: 700; margin: 0 }
  .meta { color: var(--dim); font-size: .92rem; margin: .15rem 0 .7rem }
  .pill {
    display: inline-block; border-radius: 999px;
    padding: .15rem .65rem; font-size: .82rem;
    background: #eaf3ef; color: var(--accent-ink); margin-right: .35rem;
  }
  .pill.warn { background: var(--warn-bg); color: var(--warn) }
  .muted { color: var(--dim); font-size: .9rem }
  .status {
    display: flex; gap: .75rem; flex-wrap: wrap; align-items: center;
    margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--line);
  }
  .dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--ok); display: inline-block }
  .dot.off { background: #b7c0bb }
  .toast {
    position: fixed; left: 50%; bottom: 1.25rem; transform: translateX(-50%);
    background: var(--ink); color: #fff; padding: .7rem 1.1rem;
    border-radius: 999px; font-size: .92rem; opacity: 0; pointer-events: none;
    transition: opacity .2s ease, transform .2s ease; z-index: 20;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(-4px) }
  .live {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: .82rem; color: var(--dim);
    max-height: 8rem; overflow: auto; white-space: pre-wrap;
    background: #f7faf8; border-radius: 10px; padding: .75rem; margin-top: .75rem;
    display: none;
  }
  .live.on { display: block }
  .qr { background: #fff; padding: .4rem; border-radius: 10px; border: 1px solid var(--line); width: max-content }
  .tablet-url { word-break: break-all; font-size: .85rem }
  details { margin-top: .75rem }
  summary { cursor: pointer; color: var(--accent-ink); font-weight: 600 }
  @media (max-width: 520px) {
    body { padding: 1.25rem 1rem 3.5rem }
    .child { grid-template-columns: 1fr }
  }
</style>
<body>
  <div class="wrap">
    <header>
      <h1 class="brand">primer</h1>
      <p class="tag">Your child's learning record — Claude prepares the work, you approve, they play.</p>
    </header>

    <section class="panel" id="empty" hidden>
      <h2>Add your first child</h2>
      <p class="muted" style="margin-top:0">Just a name. Everything else can wait.</p>
      <form id="add-first" class="row" style="margin-top:1rem">
        <div class="grow"><input name="name" type="text" placeholder="Name" required maxlength="80" autocomplete="name"></div>
        <button type="submit">Add</button>
      </form>
      <p class="muted" style="margin-bottom:0">Or try it with an example child first —
        <button type="button" class="ghost" id="demo">seed Ada</button></p>
    </section>

    <section class="panel" id="kids" hidden>
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">Your kids</h2>
        <a class="btn secondary" href="/review" id="review-link" hidden>Review waiting</a>
      </div>
      <div id="child-list"></div>
      <form id="add-more" class="row" style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--line)">
        <div class="grow"><input name="name" type="text" placeholder="Add another child" maxlength="80"></div>
        <button type="submit" class="secondary">Add</button>
      </form>
    </section>

    <section class="panel">
      <h2>Claude</h2>
      <p class="muted" id="transport-note" style="margin-top:0"></p>
      <div class="status">
        <span><span class="dot" id="claude-dot"></span> <span id="claude-label">checking…</span></span>
        <span class="muted" id="transport-label"></span>
      </div>
      <div class="live" id="live"></div>
    </section>

    <section class="panel">
      <h2>Tablet</h2>
      <p class="muted" style="margin-top:0" id="tablet-help">
        Start with Wi‑Fi sharing so a tablet on the same network can open activities.
      </p>
      <div class="row">
        <button type="button" id="toggle-lan" class="secondary">Turn on Wi‑Fi sharing</button>
        <button type="button" id="toggle-https" class="secondary" hidden>Enable tablet mic (HTTPS)</button>
      </div>
      <p class="muted" id="ca-help" hidden style="margin-bottom:0"></p>
    </section>
  </div>
  <div class="toast" id="toast"></div>
<script>
const INITIAL = ${data};
let state = INITIAL;

const $ = (id) => document.getElementById(id);
const toast = (msg) => {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2800);
};

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || 'request failed');
  return data;
}

function render() {
  const hasKids = state.children.length > 0;
  $('empty').hidden = hasKids;
  $('kids').hidden = !hasKids;
  $('review-link').hidden = state.waitingReview === 0;
  $('review-link').textContent = state.waitingReview
    ? \`Review \${state.waitingReview} waiting\`
    : 'Review';

  $('transport-note').textContent = state.transport.note;
  $('transport-label').textContent = state.transport.transport === 'acp' ? 'via ACP' : 'via Claude Code CLI';
  $('claude-dot').classList.toggle('off', !state.claude.found);
  $('claude-label').textContent = state.claude.found
    ? 'Claude Code found'
    : 'Claude Code not found — install it, then refresh';

  $('toggle-lan').textContent = state.lan ? 'Wi‑Fi sharing is on' : 'Turn on Wi‑Fi sharing';
  $('toggle-lan').classList.toggle('secondary', !state.lan);
  $('toggle-https').hidden = !state.lan;
  $('toggle-https').textContent = state.https ? 'HTTPS on (tablet mic)' : 'Enable tablet mic (HTTPS)';
  $('tablet-help').textContent = state.lan
    ? 'Scan a child's code below on the tablet (same Wi‑Fi). Then Add to Home Screen.'
    : 'Turn on Wi‑Fi sharing so a tablet can reach activities on this computer.';
  if (state.caUrl) {
    $('ca-help').hidden = false;
    $('ca-help').innerHTML = 'First install the certificate on the tablet: <code class="tablet-url">' +
      escapeHtml(state.caUrl) + '</code>';
  } else {
    $('ca-help').hidden = true;
  }

  const list = $('child-list');
  list.innerHTML = state.children.map((c) => childHtml(c)).join('');
  list.querySelectorAll('[data-prepare]').forEach((btn) => {
    btn.addEventListener('click', () => prepare(btn.getAttribute('data-prepare'), btn));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function childHtml(c) {
  const initial = escapeHtml((c.name || '?').trim().charAt(0).toUpperCase() || '?');
  const pills = [
    c.review ? \`<span class="pill warn">\${c.review} to review</span>\` : '',
    c.ready ? \`<span class="pill">\${c.ready} ready</span>\` : '<span class="pill">nothing waiting</span>',
    c.age ? \`<span class="pill">\${c.age} yrs</span>\` : '',
  ].filter(Boolean).join('');
  return \`<div class="child">
    <div class="avatar" style="background:\${escapeHtml(c.color)}">\${initial}</div>
    <div>
      <p class="name">\${escapeHtml(c.name)}</p>
      <div class="meta">\${pills}</div>
      <div class="row">
        <button type="button" data-prepare="\${escapeHtml(c.id)}">Prepare work</button>
        <a class="btn secondary" href="/progress/\${encodeURIComponent(c.slug)}">Progress</a>
      </div>
      \${state.lan ? \`<details>
        <summary>Tablet setup</summary>
        <div class="row" style="margin-top:.75rem;align-items:flex-start">
          \${c.qr ? \`<div class="qr">\${c.qr}</div>\` : ''}
          <div>
            <p class="muted" style="margin:0 0 .4rem">Open on the tablet:</p>
            <code class="tablet-url">\${escapeHtml(c.tabletUrl)}</code>
          </div>
        </div>
      </details>\` : ''}
    </div>
  </div>\`;
}

async function refresh() {
  const res = await fetch('/api/app/status');
  state = await res.json();
  render();
}

async function prepare(id, btn) {
  const live = $('live');
  live.classList.add('on');
  live.textContent = 'Asking Claude to prepare…\\n';
  btn.disabled = true;
  try {
    const result = await api('/api/app/prepare', { learner: id });
    live.textContent += (result.summary || 'Done.') + '\\n';
    if (result.transport) live.textContent += '(' + result.transport + ')\\n';
    toast(result.activities_planned
      ? result.activities_planned + ' activit' + (result.activities_planned === 1 ? 'y' : 'ies') + ' ready to review'
      : (result.summary || 'Done'));
    await refresh();
  } catch (err) {
    live.textContent += String(err.message || err) + '\\n';
    toast(String(err.message || err));
  } finally {
    btn.disabled = false;
  }
}

async function addChild(form) {
  const name = new FormData(form).get('name');
  await api('/api/app/learner', { name });
  form.reset();
  toast('Added');
  await refresh();
}

$('add-first').addEventListener('submit', (e) => { e.preventDefault(); addChild(e.target).catch((err) => toast(err.message)); });
$('add-more').addEventListener('submit', (e) => { e.preventDefault(); addChild(e.target).catch((err) => toast(err.message)); });
$('demo').addEventListener('click', async () => {
  try {
    await api('/api/app/demo', {});
    toast('Ada is ready');
    await refresh();
  } catch (err) { toast(err.message); }
});
$('toggle-lan').addEventListener('click', async () => {
  try {
    const data = await api('/api/app/flags', { lan: !state.lan });
    toast(data.message || 'Restarting with new settings…');
  } catch (err) { toast(err.message); }
});
$('toggle-https').addEventListener('click', async () => {
  try {
    const data = await api('/api/app/flags', { https: !state.https, lan: true });
    toast(data.message || 'Restarting with HTTPS…');
  } catch (err) { toast(err.message); }
});

render();
</script>
</body>
</html>`;
}
