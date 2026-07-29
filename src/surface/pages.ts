import { all, one, parseJson } from '../db/index.ts';
import type { Learner } from '../domain/types.ts';
import { listLearners, interests, accommodations, ageYears } from '../record/learners.ts';
import { pendingReview, queue, readyCount, type PlannedActivity } from '../record/queue.ts';
import { progressReport } from '../record/report.ts';
import { listArtifacts, describeArtifact } from '../record/artifacts.ts';
import { settings, deviceCapabilities } from '../agent/config.ts';
import { slugFor, colorFor, lanAddresses } from './pwa.ts';
import { childToken } from './security.ts';
import { qrSvg } from './qr.ts';

/**
 * The adult's surface.
 *
 * Three pages, and they are the only screens in this project that look the same
 * twice: home, review, progress. Everything a child sees is generated. Everything
 * an adult sees is fixed, plain, and boring on purpose — a parent checking in
 * between other things should not have to learn a new layout each visit.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

const STYLE = `
:root { --ink:#241c15; --dim:#6b6257; --paper:#faf8f4; --card:#fff; --line:#e5ded2;
        --yes:#2f7d4f; --no:#b4531f; }
* { box-sizing:border-box }
body { font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink);
       background:var(--paper); max-width:46rem; margin:0 auto; padding:2.5rem 1.25rem 5rem }
a { color:#2b5f8f }
h1 { font-size:1.6rem; margin:0 0 .25rem }
h2 { font-size:1.1rem; margin:0 0 .5rem }
.sub { color:var(--dim); margin:0 0 2rem }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px;
        padding:1.25rem 1.4rem; margin:1rem 0 }
.row { display:flex; gap:.75rem; flex-wrap:wrap; align-items:center }
.badge { display:inline-block; background:#f0ece3; border-radius:999px;
         padding:.15rem .7rem; font-size:.85rem; color:var(--dim) }
.badge.alert { background:#fdf0e6; color:var(--no) }
.big { display:inline-block; font-size:1.05rem; font-weight:600; text-decoration:none;
       border:2px solid var(--ink); border-radius:10px; padding:.6rem 1.2rem; color:var(--ink) }
.big:hover { background:var(--ink); color:var(--paper) }
.muted { color:var(--dim); font-size:.9rem }
ul.plain { list-style:none; padding:0; margin:.5rem 0 }
ul.plain li { padding:.35rem 0; border-bottom:1px solid var(--line) }
ul.plain li:last-child { border-bottom:0 }
nav { margin-bottom:2rem; font-size:.92rem }
nav a { margin-right:1rem }
.empty { color:var(--dim); font-style:italic }
.setup { background:#f4f1ea; border-radius:10px; padding:1rem 1.1rem; margin-top:1.1rem }
.setup code { background:#fff; padding:.15rem .4rem; border-radius:4px; font-size:.9rem }
@media (max-width:520px) { body { padding:1.5rem 1rem 4rem } .big { width:100% ; text-align:center } }
`;

function shell(title: string, body: string, nav = true): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style>
${nav ? '<nav><a href="/">Home</a><a href="/review">Review</a><a href="/how">How this works</a></nav>' : ''}
${body}`;
}

/* ------------------------------------------------------------------- home -- */

export function homePage(): string {
  const children = listLearners();
  if (!children.length) {
    return shell(
      'primer',
      `<h1>primer</h1>
<p class="sub">No children in this record yet.</p>
<div class="card">
  <p>Add one from a terminal:</p>
  <p><code>primer learner:add "Name"</code></p>
  <p class="muted">Or <code>primer demo</code> to see how it works with an example child first.</p>
</div>`,
      false,
    );
  }

  const cards = children.map((child) => childCard(child)).join('');
  const waiting = pendingReview().length;

  return shell(
    'primer',
    `<h1>primer</h1>
<p class="sub">${
      waiting
        ? `${waiting} activit${waiting === 1 ? 'y' : 'ies'} waiting for you to look at.`
        : 'Nothing needs you right now.'
    } <a href="/how" class="muted">How this works</a></p>
${cards}`,
  );
}

function childCard(child: Learner): string {
  const ready = readyCount(child.id);
  const review = pendingReview(child.id).length;
  const age = ageYears(child);

  const lastSession = one<{ started_at: string; summary: string | null }>(
    `SELECT started_at, summary FROM session WHERE learner_id = ? AND ended_at IS NOT NULL
      ORDER BY ended_at DESC LIMIT 1`,
    child.id,
  );

  const badges = [
    review ? `<span class="badge alert">${review} to review</span>` : '',
    ready ? `<span class="badge">${ready} ready for them</span>` : '',
    age ? `<span class="badge">${age} years old</span>` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const slug = slugFor(child);
  const { bg } = colorFor(child.id);

  return `<div class="card">
  <div class="row" style="align-items:flex-start;gap:1rem">
    <span style="flex:0 0 44px;height:44px;border-radius:12px;background:${bg};color:#fffdf8;
      display:flex;align-items:center;justify-content:center;font:600 24px Georgia,serif">${escapeHtml(
        (child.display_name.trim()[0] ?? '?').toUpperCase(),
      )}</span>
    <div style="flex:1 1 12rem">
      <h2 style="margin:.2rem 0 .4rem">${escapeHtml(child.display_name)}</h2>
      <div class="row">${badges || '<span class="muted">nothing queued</span>'}</div>
    </div>
  </div>
  ${
    lastSession
      ? `<p class="muted" style="margin-top:.9rem">Last worked ${timeAgo(lastSession.started_at)}${
          lastSession.summary ? ` — ${escapeHtml(lastSession.summary.split('. ')[0]!)}.` : '.'
        }</p>`
      : '<p class="muted" style="margin-top:.9rem">Has not worked on anything yet.</p>'
  }
  <p class="row" style="margin-top:1.1rem">
    ${review ? `<a class="big" href="/review">Review ${review} activit${review === 1 ? 'y' : 'ies'}</a>` : ''}
    <a href="/progress/${slug}">How they are doing</a>
    <a href="/k/${slug}">Open their app here</a>
  </p>
  ${deviceSetup(child, slug)}
</div>`;
}

/**
 * How a child actually gets to this on the device they will use.
 *
 * Point a camera at the code, then Add to Home Screen. After that it opens like any
 * other app — their name, their colour, full screen, no address bar — and there is
 * no way from inside it to reach anything but their own activities.
 */
function deviceSetup(child: Learner, slug: string): string {
  const addresses = lanAddresses();
  const port = Number(process.env.PRIMER_PORT ?? 7333);

  if (!addresses.length) {
    return `<div class="setup"><p><strong>To put this on a tablet</strong>, connect this
    computer to wifi. Right now it has no network address another device could reach.</p></div>`;
  }

  // The key travels once, in the link the parent scans. The device keeps it; the
  // child never sees it and never types anything.
  const url = `http://${addresses[0]}:${port}/k/${slug}?t=${childToken()}`;
  let qr = '';
  try {
    qr = qrSvg(url, { size: 190 });
  } catch {
    qr = '';
  }

  return `<div class="setup">
  <div style="display:flex;gap:1.25rem;flex-wrap:wrap;align-items:flex-start">
    ${qr ? `<div style="flex:0 0 auto;background:#fff;padding:.5rem;border-radius:10px">${qr}</div>` : ''}
    <div style="flex:1 1 15rem;min-width:14rem">
      <strong>Put this on ${escapeHtml(child.display_name)}'s tablet</strong>
      <ol style="margin:.5rem 0 0;padding-left:1.2rem">
        <li>Put the tablet on the same wifi as this computer.</li>
        <li>${qr ? 'Point its camera at the code' : 'Open its browser'} — or type this in:<br>
            <code style="display:inline-block;margin-top:.25rem;word-break:break-all">${escapeHtml(url)}</code></li>
        <li>Tap <em>Share</em>, then <em>Add to Home Screen</em>.</li>
      </ol>
      <p class="muted" style="margin:.6rem 0 0">The link carries a key, so treat it like
      a house key. It opens activities — and only activities. The recordings, the notes,
      the progress pages and this page stay on this computer and cannot be reached from
      the network at all.</p>
      <p class="muted" style="margin:.4rem 0 0">There is one key per household, not one
      per child, so a device holding it can open any child's activities here.</p>
      <p class="muted" style="margin:.7rem 0 0">It then opens like any other app, with
      ${escapeHtml(child.display_name)}'s name on it.</p>
    </div>
  </div>
  <p class="muted" style="margin:.9rem 0 0">Needs <code>primer start --lan</code>. If the
  code will not connect, your wifi may block devices from talking to each other — a
  phone hotspot works instead.</p>
</div>`;
}

/**
 * What this actually is, for the person who just opened it and does not know what
 * they are looking at.
 *
 * Written as a week rather than a feature list, because the question people
 * actually ask is not "what does it do" but "what am I supposed to do."
 */
export function howPage(): string {
  const children = listLearners();
  const child = children[0];
  const name = child ? escapeHtml(child.display_name) : 'your child';
  const slug = child ? slugFor(child) : 'name';

  return shell(
    'How this works — primer',
    `<h1>How this works</h1>
<p class="sub">Three things happen, on their own schedule. You are only needed for one of them.</p>

<div class="card">
  <h2>1. Claude prepares something, while nobody is watching</h2>
  <p>Every few hours it reads ${name}'s record — what has stuck, what has slipped, what
  they keep getting wrong in the same way, what they are into this month — and builds
  one or two activities for them. Then it stops.</p>
  <p class="muted">You do not prompt it. It runs from <code>primer start --watch</code>,
  or you can ask for one now with <code>primer tutor ${child ? escapeHtml(child.display_name) : '&lt;name&gt;'}</code>.
  It refuses to run if there is already a pile waiting, or if it ran too recently.</p>
</div>

<div class="card">
  <h2>2. You look at it — this is the only part that needs you</h2>
  <p>New activities wait on the <a href="/review">review page</a> until you say yes.
  Nothing reaches ${name} before that. Open it, play with it for a minute, and approve
  or reject it. Rejecting is free and useful: your note is read before the next one is
  built.</p>
  <p class="muted">A minute, a few times a week. That is the whole job.</p>
</div>

<div class="card">
  <h2>3. ${name} opens their app</h2>
  <p>On their tablet, their app has their name on it. Whatever you approved is what
  opens — no menu, no library, nothing to browse or get lost in. When there is nothing
  waiting it says so and tells them to go do something else.</p>
  <p>Everything they do comes back into the record: what they answered, in their own
  words, and how long they thought about it. That is what tomorrow's activity is built
  from. There is no separate "progress tracking" — using the thing is the assessment.</p>
  <p class="muted">Their app lives at <code>/k/${slug}</code>. Put it on their tablet
  from the <a href="/">home page</a>.</p>
</div>

<div class="card">
  <h2>What it is for</h2>
  <p>Not a replacement for school, and not a thing to leave a child alone with for an
  hour. It is closer to what a good tutor does between sessions: remembering, noticing a
  pattern across weeks, and turning up next time with something made for this child
  rather than for a class of thirty.</p>
  <p>The record is the point. The activities are disposable — they are built, used, and
  never opened again. What lasts is everything ${name} has ever tried, kept in one file
  that you own and can take anywhere.</p>
</div>

<div class="card">
  <h2>Where things are</h2>
  <ul class="plain">
    <li><a href="/">Home</a> — your children, what needs you, and the code to put an app on a tablet</li>
    <li><a href="/review">Review</a> — what Claude built, waiting on you</li>
    ${child ? `<li><a href="/progress/${slug}">How ${name} is doing</a> — in plain language, not percentages</li>` : ''}
  </ul>
</div>`,
  );
}

/* --------------------------------------------------------------- progress -- */

export function progressPage(learnerId: string): string {
  const report = progressReport(learnerId, 30);
  const name = escapeHtml(report.learner.name);

  const mastered = report.newly_mastered.length
    ? `<ul class="plain">${report.newly_mastered
        .map((s) => `<li>${escapeHtml(s.name)} <span class="muted">(${s.domain})</span></li>`)
        .join('')}</ul>`
    : '<p class="empty">Nothing finished in the last month.</p>';

  const working = report.working_on.length
    ? `<ul class="plain">${report.working_on
        .slice(0, 8)
        .map((s) => `<li>${escapeHtml(s.name)}</li>`)
        .join('')}</ul>`
    : '<p class="empty">Nothing in progress.</p>';

  const stuck = report.needs_a_different_approach.length
    ? `<ul class="plain">${report.needs_a_different_approach
        .map(
          (s) =>
            `<li>${escapeHtml(s.name)} <span class="muted">— ${s.opportunities} tries, still not clicking</span></li>`,
        )
        .join('')}</ul>`
    : '';

  const openMisconceptions = report.misconceptions.open.length
    ? `<ul class="plain">${report.misconceptions.open
        .map((m) => `<li>${escapeHtml(m.pattern)} <span class="muted">— seen ${m.seen}×</span></li>`)
        .join('')}</ul>`
    : '<p class="empty">None being tracked.</p>';

  const notes = all<{ text: string; author_role: string; created_at: string }>(
    `SELECT text, author_role, created_at FROM note WHERE learner_id = ?
      ORDER BY created_at DESC LIMIT 4`,
    learnerId,
  );

  const likes = interests(learnerId)
    .slice(0, 6)
    .map((i) => escapeHtml(i.topic))
    .join(', ');

  const musts = accommodations(learnerId)
    .map((a) => `<li>${escapeHtml(a.detail)}</li>`)
    .join('');

  return shell(
    `${report.learner.name} — primer`,
    `<h1>${name}</h1>
<p class="sub">Last 30 days: ${report.totals.sessions} session${report.totals.sessions === 1 ? '' : 's'},
${report.totals.minutes} minutes, ${report.totals.observations} things tried.</p>

${
  notes.length
    ? `<div class="card"><h2>Notes from the tutor</h2><ul class="plain">${notes
        .map(
          (n) =>
            `<li>${escapeHtml(n.text)}<br><span class="muted">${escapeHtml(n.author_role)}, ${timeAgo(n.created_at)}</span></li>`,
        )
        .join('')}</ul></div>`
    : ''
}

<div class="card"><h2>Finished recently</h2>${mastered}</div>
<div class="card"><h2>Working on now</h2>${working}</div>
${stuck ? `<div class="card"><h2>Not clicking yet</h2>${stuck}<p class="muted">The tutor will try a different angle rather than repeating these.</p></div>` : ''}
<div class="card"><h2>Mix-ups being worked on</h2>${openMisconceptions}</div>

${recordingsSection(learnerId, name)}

<div class="card">
  <h2>What the tutor knows about them</h2>
  <p>Likes: ${likes || '<span class="empty">nothing recorded yet</span>'}</p>
  ${musts ? `<p>Always honored:</p><ul class="plain">${musts}</ul>` : ''}
</div>

<p class="muted">Every number here comes from something ${name} actually did. Run
<code>primer export "${name}"</code> to take the whole record with you.</p>`,
  );
}

/**
 * The child reading, in their own voice.
 *
 * The model cannot listen to these. You can — and what you hear goes back into the
 * record as evidence, the same as anything else. Fluency is the one thing taps
 * cannot measure, and in five years this is the part of the record worth keeping.
 */
function recordingsSection(learnerId: string, name: string): string {
  const clips = listArtifacts(learnerId, 8).map(describeArtifact).filter((a) => a.exists);
  const device = deviceCapabilities(learnerId) as { microphone?: boolean } | null;

  // The honest version of "recording is on but nothing appears". Browsers refuse
  // the microphone outside a secure context, so a tablet on a plain-HTTP LAN
  // address cannot record at all — and says nothing about it.
  const cannotRecord =
    settings().audio_capture && device && device.microphone === false
      ? `<div class="card"><h2>${name} reading aloud</h2>
<p><strong>Recording is switched on, but ${name}'s tablet cannot record.</strong></p>
<p class="muted">Browsers only allow the microphone over a secure connection. On this
computer it works; on a tablet reached by its network address it does not, and the
browser gives no warning — which is why nothing has appeared here.</p>
<p class="muted">For now, recordings only work when the activity is opened on this
computer. Making it work on the tablet needs HTTPS, which is not set up yet.</p></div>`
      : '';
  if (cannotRecord) return cannotRecord;

  if (!clips.length) {
    return settings().audio_capture
      ? `<div class="card"><h2>${name} reading aloud</h2>
<p class="empty">No recordings yet. Activities that ask ${name} to read out loud will save them here.</p></div>`
      : '';
  }

  const rows = clips
    .map(
      (c) => `<li>
  <div>${escapeHtml(c.prompt ?? 'Reading aloud')}
    <span class="muted">— ${timeAgo(c.recorded_at)}${c.duration_seconds ? `, ${c.duration_seconds}s` : ''}</span>
  </div>
  <audio controls preload="none" src="${escapeHtml(c.url)}" style="width:100%;margin-top:.4rem"></audio>
  ${c.transcript ? `<p class="muted">“${escapeHtml(c.transcript)}”</p>` : ''}
  ${
    c.reviewed
      ? '<p class="muted">You have listened to this.</p>'
      // The id goes in a data- attribute, not inside the onclick string: an id is
      // an untrusted value once a record has been imported from elsewhere, and
      // concatenating it into a JS string literal is how that becomes stored XSS
      // on this page, which runs with unsafe-inline and can act as the parent.
      : `<p class="muted">Not listened to yet.
         <button data-artifact="${escapeHtml(c.id)}" onclick="heard(this.dataset.artifact)"
           style="font:inherit;padding:.2rem .7rem;
           border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer">Mark as heard</button></p>`
  }
</li>`,
    )
    .join('');

  return `<div class="card">
  <h2>${name} reading aloud</h2>
  <ul class="plain">${rows}</ul>
  <p class="muted">These stay on this machine. Nothing is uploaded, and the tutor cannot
  hear them — but what you notice can go in the record.</p>
</div>
<script>
async function heard(id) {
  await fetch('/api/artifact/' + id + '/reviewed', { method: 'POST' });
  location.reload();
}
</script>`;
}

/* ----------------------------------------------------------------- review -- */

export function reviewPage(items: PlannedActivity[]): string {
  if (!items.length) {
    return shell(
      'Review — primer',
      `<h1>Review</h1>
<p class="sub">Nothing waiting for approval.</p>
<div class="card"><p>When the tutor prepares something new, it will appear here first.
No child sees anything until you say so.</p></div>`,
    );
  }

  const cards = items.map(reviewCard).join('');

  return shell(
    'Review — primer',
    `<h1>Review</h1>
<p class="sub">${items.length} activit${items.length === 1 ? 'y' : 'ies'} waiting. Nothing here has been shown to a child.</p>
<div class="card" style="background:#f4f1ea">
  <strong>What to do</strong>
  <ol style="margin:.5rem 0 0;padding-left:1.25rem">
    <li>Click <em>Try it yourself</em> and play with it for a minute.</li>
    <li>Happy to hand it over? <em>Approve</em> — it goes into their queue.</li>
    <li>Not happy? <em>Reject</em>, and say why. The tutor reads your note before planning again.</li>
  </ol>
  <p class="muted" style="margin:.7rem 0 0">Nothing is lost by rejecting. It will build something else.</p>
</div>
${cards}
<script>
document.addEventListener('click', function (event) {
  const button = event.target.closest('button[data-decide]');
  if (button) decide(button.closest('.card'), button.dataset.decide);
});

async function decide(card, decision) {
  const id = card.dataset.activity;
  const name = card.dataset.name;
  const box = document.getElementById('n_' + id);
  const note = box ? box.value || null : null;
  card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });

  const res = await fetch('/review/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activity_id: id, decision: decision, note: note }),
  });
  const body = await res.json().catch(function () { return {}; });

  // Say plainly what happened and where it went — silently reloading is how a
  // person ends up asking "did that work?". Built with DOM calls rather than an
  // HTML string, so a child's name is text and can never be markup.
  const they = card.dataset.subject, their = card.dataset.possessive;
  card.replaceChildren();
  const heading = document.createElement('h2');
  const detail = document.createElement('p');
  const actions = document.createElement('p');
  actions.className = 'row';

  if (decision === 'approve') {
    heading.textContent = 'Approved';
    detail.textContent = name + ' will see this next time ' + they + ' opens ' + their + ' page.';
    const open = document.createElement('a');
    open.className = 'big';
    open.href = body.child_url || '/';
    open.textContent = 'Open ' + their + ' page now';
    actions.append(open);
  } else {
    heading.textContent = 'Rejected';
    detail.textContent = name + ' will not see this. The tutor reads your note before it plans again.';
  }

  const back = document.createElement('a');
  back.href = '/review';
  back.textContent = 'Back to review';
  actions.append(back);
  card.append(heading, detail, actions);
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
</script>`,
  );
}

function reviewCard(a: PlannedActivity): string {
  // The tutor is told to lead with one plain sentence about what the child does,
  // then explain. Show that sentence; tuck the reasoning behind a toggle.
  const rationale = a.rationale ?? '';
  const split = rationale.search(/(?<=[.!?])\s+/);
  const lead = split > 0 ? rationale.slice(0, split) : rationale;
  const rest = split > 0 ? rationale.slice(split).trim() : '';
  const child = one<{ display_name: string }>(
    `SELECT display_name FROM learner WHERE id = ?`,
    a.learner_id,
  );
  const name = escapeHtml(child?.display_name ?? 'They');
  const p = pronounsFor(a.learner_id);

  // The child's name travels in a data attribute, never interpolated into a JS
  // string inside an onclick. The HTML parser decodes entities before JS parses
  // the attribute, so an escaped apostrophe becomes a real one — a child called
  // O'Brien would otherwise break the only control in the product, and a name
  // containing markup would run on the adult's page.
  // Every id below is escaped even though it is normally an internally-generated
  // string, because it stops being one the moment a record has been imported — an
  // import file is an untrusted document, and this page runs with unsafe-inline,
  // so an unescaped id here is stored XSS on the parent's own approval gate.
  return `<div class="card" id="c_${escapeHtml(a.id)}" data-activity="${escapeHtml(a.id)}"
    data-name="${name}" data-subject="${p.subject}" data-possessive="${p.possessive}">
  <h2>${escapeHtml(a.title)}</h2>
  <p>${escapeHtml(lead || 'The tutor did not say what this is. Worth rejecting and asking why.')}</p>
  ${rest ? `<details><summary class="muted">Why this, why now</summary><p class="muted">${escapeHtml(rest)}</p></details>` : ''}
  <p class="muted" style="margin-top:.9rem">Prepared ${timeAgo(a.created_at)} for ${name}</p>
  <p><a class="big" href="/i/${encodeURIComponent(a.interface_id ?? '')}" target="_blank" rel="noopener">Try it yourself</a>
     <span class="muted">opens in a new tab — nothing you do counts as theirs</span></p>
  <textarea id="n_${escapeHtml(a.id)}" style="width:100%;min-height:3.2rem;font:inherit;padding:.5rem;
    border:1px solid var(--line);border-radius:6px;margin-top:.8rem"
    placeholder="Optional: tell the tutor what you think."></textarea>
  <p class="row" style="margin-top:.6rem">
    <button data-decide="approve"
      style="font:inherit;padding:.55rem 1.1rem;border-radius:8px;cursor:pointer;
      border:2px solid var(--yes);color:var(--yes);background:#fff">Approve</button>
    <button data-decide="reject"
      style="font:inherit;padding:.55rem 1.1rem;border-radius:8px;cursor:pointer;
      border:2px solid var(--no);color:var(--no);background:#fff">Reject</button>
  </p>
</div>`;
}

/* ------------------------------------------------------------------ child -- */

/** What a child sees when nothing is approved. No streaks, no "come back soon". */
export function nothingWaitingPage(name: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nothing right now</title>
<style>body{font:22px/1.8 Verdana,system-ui,sans-serif;color:#241c15;background:#f7f1e6;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:2rem;text-align:center}
p{max-width:20rem}</style>
<p>Nothing new right now, ${escapeHtml(name)}.<br>Go find something else to do.</p>`;
}

/* ------------------------------------------------------------------ utils -- */

/**
 * Use the pronouns the record holds. Where none were recorded, they/them — a name
 * is not evidence of anything, and guessing wrong about a child in front of their
 * parent is worse than being neutral.
 */
export function pronounsFor(learnerId: string): { subject: string; possessive: string } {
  const row = one<{ pronouns: string | null }>(
    `SELECT pronouns FROM learner WHERE id = ?`,
    learnerId,
  );
  const first = (row?.pronouns ?? '').split(/[\/\s,]+/)[0]?.toLowerCase();
  if (first === 'she') return { subject: 'she', possessive: 'her' };
  if (first === 'he') return { subject: 'he', possessive: 'his' };
  return { subject: 'they', possessive: 'their' };
}

export function timeAgo(iso: string, at = new Date()): string {
  const ms = at.getTime() - new Date(iso).getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

export function queueSummary(learnerId: string) {
  return queue(learnerId).map((a) => ({
    title: a.title,
    status: a.status,
    skills: parseJson<string[]>(a.target_skills, []),
  }));
}
