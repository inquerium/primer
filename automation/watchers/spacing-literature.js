// Research-lane watcher: one claim family, one query, diff the DOI set.
// See docs/OPENCLAW.md. Read-only by contract; actions belong in the payload,
// because state from a failed payload run is not persisted.
//
// The runtime provides `tools` (tool calls under the owning agent's policy),
// `trigger` (carrying the frozen state from the last run), and `json` (how a
// watcher returns its verdict). The payload runs only on `fire: true`.
//
// Why a DOI set and not a content hash: hashing a page fires on view counters,
// rotating sidebars, and session tokens, so the watcher would wake the model
// every week and the maintainer would learn to ignore it. New DOIs since the
// last check are a real signal. Changed bytes are not.
//
// Why an ISSN allowlist: "spacing" and "retention" are cross-disciplinary
// homonyms. A relevance query alone returns aerospace, civil engineering, and
// nurse-staffing papers. Measured against the live API on 2026-07-30, the
// unrestricted query matched 153,105 works; restricted to these journals it
// matched 45, all on topic. Precision matters more than recall here, because
// this feeds an agent that writes citations. The proposer can web_search
// freely for anything this misses.

const CLAIM_FAMILY = 'spacing'; // -> world/claims/spacing.md

// ISSNs verified against api.crossref.org/journals on 2026-07-30. The list
// deliberately covers the venues world/claims/spacing.md already cites: a
// watcher that cannot see the journals its own claims came from would never
// notice those claims being superseded.
const JOURNALS = [
  '0033-2909', // Psychological Bulletin            (Cepeda et al. 2006)
  '0956-7976', // Psychological Science             (Cepeda 2008; Roediger & Karpicke 2006)
  '0278-7393', // Journal of Experimental Psychology: Learning, Memory, and Cognition
  '0749-596X', // Journal of Memory and Language
  '0022-0663', // Journal of Educational Psychology
  '2211-3681', // Journal of Applied Research in Memory and Cognition
  '1040-726X', // Educational Psychology Review
  '0007-0998', // British Journal of Educational Psychology
  '0888-4080', // Applied Cognitive Psychology
];

const QUERY = 'spacing distributed practice retrieval retention';

// TODO(operator): set a real contact address before registering this watcher.
// Crossref reserves a faster pool for callers who identify themselves, and a
// working address is how they reach you before they rate-limit you.
const MAILTO = 'tonystark@tamu.edu';

// Measured across the journals above on 2026-07-30: 33 works in 12 months,
// about 0.6 per week, with 0 in the trailing 14 days. At this rate a threshold
// of 2 would leave the pipeline silent for months and indistinguishable from a
// broken one, so it fires on a single new paper. Raise it if the queue ever
// outpaces review, which is the failure docs/OPENCLAW.md actually warns about.
const MIN_NEW = 1;
const POLL_DAYS = 14; // lookback per run, comfortably wider than the 7d cadence
const COLD_LOOKBACK = 30; // days, first run only
const KEEP = 300; // rolling DOI cap; ~30 bytes each against a 16 KB state limit

const days = trigger.state ? POLL_DAYS : COLD_LOOKBACK;
const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

const filters = [
  `from-created-date:${since}`,
  'type:journal-article',
  ...JOURNALS.map((issn) => `issn:${issn}`),
].join(',');

const url =
  'https://api.crossref.org/works' +
  `?query.bibliographic=${encodeURIComponent(QUERY)}` +
  `&filter=${filters}` +
  '&select=DOI,title,created&sort=created&order=desc&rows=50' +
  `&mailto=${encodeURIComponent(MAILTO)}`;

// How many consecutive failures before breakage is worth a model turn. The
// attacker watcher learned this the expensive way: firing on the first failed
// check cost eight aborted runs and eight alerts in a day, because the machine
// was offline and waking an agent to diagnose a missing network is
// self-defeating. Its own provider call needs the same network. A call that
// never completed is counted. A call that completed and came back wrong is
// announced at once, since a response arriving proves the network is up and
// something about the Crossref contract has actually changed.
//
// This watcher runs weekly, so a streak of 2 means one missed cycle before the
// maintainer hears about it. That is the right trade against a guaranteed
// wasted run every time the laptop happens to be asleep on the hour.
const CONNECT_ALERT_AFTER = 2;
const SHAPE_ALERT_AFTER = 1;

let items = null;
let failure = '';
let shapeFailure = false;
try {
  const res = await tools.call('exec', {
    command: `curl -sS --max-time 20 '${url}'`,
  });
  const body = JSON.parse(String(res?.result?.details?.aggregated ?? ''));
  if (body?.status !== 'ok' || !Array.isArray(body?.message?.items)) {
    failure = `unexpected Crossref response shape (status ${body?.status ?? 'none'})`;
    shapeFailure = true;
  } else {
    items = body.message.items;
  }
} catch (err) {
  failure = String(err).slice(0, 200);
}

if (failure) {
  // A watcher that goes quiet when its check breaks is indistinguishable from a
  // healthy watcher with nothing to report, so persistent breakage still has to
  // speak. It just does not have to speak on the first stumble.
  const prev = trigger.state ?? {};
  const streak = (prev.failStreak ?? 0) + 1;
  const firstFailAt = prev.firstFailAt ?? Date.now();
  const threshold =
    prev.nextAlertAt ?? (shapeFailure ? SHAPE_ALERT_AFTER : CONNECT_ALERT_AFTER);
  const alert = streak >= threshold;
  const days = Math.round((Date.now() - firstFailAt) / 864e5);

  json({
    fire: alert,
    message: alert
      ? `WATCHER BROKEN (${CLAIM_FAMILY}): the Crossref check has failed ` +
        `${streak} time${streak === 1 ? '' : 's'} in a row, over about ` +
        `${days} day${days === 1 ? '' : 's'}. Latest: ${failure}. Do not ` +
        'propose claims from this run. If your own web and provider calls are ' +
        'also failing, this is the machine being offline rather than the ' +
        'watcher being wrong: say that in one sentence and stop, do not retry ' +
        'in a loop. Otherwise diagnose it and report.'
      : undefined,
    // Spread the previous state so the DOI set survives an outage. Wiping it
    // would make the next successful run treat several hundred known papers as
    // new. Both success paths below write fresh state without these counters,
    // which is how a recovered check resets its streak and its backoff.
    state: {
      ...prev,
      failStreak: streak,
      firstFailAt,
      nextAlertAt: alert ? streak * 4 : threshold,
      lastError: failure.slice(0, 120),
    },
  });
} else {
  const seen = new Set(trigger.state?.dois ?? []);
  const fresh = items.filter((w) => w.DOI && !seen.has(w.DOI));
  const dois = [...seen, ...fresh.map((w) => w.DOI)].slice(-KEEP);

  if (!trigger.state) {
    // Seed silently. Firing on the first run would hand the proposer a batch
    // of everything published in the lookback window, which is not one
    // coherent proposal and cannot become one PR.
    json({ fire: false, state: { dois, seededAt: Date.now() } });
  } else {
    json({
      // The titles and DOIs travel in the message because the fired payload
      // receives this string as its entire event context. "Something changed"
      // would force the proposer to re-derive what the watcher already knew.
      fire: fresh.length >= MIN_NEW,
      message:
        `${fresh.length} new works in the ${CLAIM_FAMILY} claim family:\n` +
        fresh.map((w) => `- ${w.title?.[0] ?? '(untitled)'} — ${w.DOI}`).join('\n') +
        '\n\nRead these, then follow the proposer protocol in docs/OPENCLAW.md. ' +
        `Target: world/claims/${CLAIM_FAMILY}.md and any file in world/priors/ ` +
        'carrying depends_on_claims for this family. Resolve every DOI before ' +
        'citing it. A TODO source is honest; an invented DOI is a firing offense. ' +
        'The ISSN filter is a venue filter, not a topic filter, so some of these ' +
        'will be off topic. If none of them warrants a change, reply saying so in ' +
        'one sentence and open no PR. An empty week is a normal outcome; a PR ' +
        'manufactured to look productive is not.',
      state: { dois, checkedAt: Date.now() },
    });
  }
}
