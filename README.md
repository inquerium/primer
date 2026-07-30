# primer

**A MyChart for a child's education.** An open, local-first record of what one child knows,
struggles with, cares about, and how they learn — plus an MCP server so an AI tutor can read
it, teach from it, and write back what it learned.

There is no app in this repository. That is deliberate.

```
  the record  ──►  Claude reads the whole child  ──►  builds an interface
      ▲            (unattended, between sessions)      that did not exist
      │                                                ten seconds ago
      │                                                       │
      │                                              a parent approves it
      │                                                       │
      └──────────  every tap flows back as evidence  ◄────────┘
```

The child never talks to a model. They open one page and whatever was prepared for
them is there.

In *The Diamond Age*, the Primer is not a book with pages. It is a book that becomes whatever
this particular girl needs today, and keeps becoming it for years. The interesting part was
never the illustrations. It was that the book **knew her** — and kept knowing her as she
changed.

That is what this repository is: the part that knows her. The interface is generated fresh,
per child, per session, and thrown away. The record is the thing that lasts.

---

## Why a record and not an app

Every education product ships an interface and treats the child's data as exhaust. When the
company pivots or dies, the data dies. The child starts over. Again.

Medicine solved this badly and then less badly: your chart is yours, it is portable, and any
clinician can read it. Education has no equivalent. A first-grade teacher gets a folder of
worksheets and a reading level; everything a tutor actually needs — that she reads every
short e as short i, that timers make her shut down, that she will work twice as long if
dinosaurs are involved — lives in one adult's head and evaporates in June.

So: put the child in the middle. One SQLite file. Every attempt she ever made, kept forever.
An explicit model of what she knows and what has slipped. A list of her actual misconceptions.
Her interests. Her accommodations. What worked and what did not.

Then hand that to a tutor that can build anything.

## Why no fixed interface

Because a tutor who can generate software should not be stuck shipping the same worksheet to
every child. A record this rich supports interfaces that no product team would ever build,
because each one is worth building for exactly one child for exactly one afternoon:

- a dig site where two words are buried and she picks the one the sentence needs — because
  choosing between two visible words is easier for her than reading one aloud
- a number line as long as the hallway, because he learns with his whole body
- a story that stops mid-sentence and needs a word spelled to continue, starring his dog

`examples/short-e-minimal-pairs.html` is one of these, built for the demo child from her
actual record. Read the comment at the top: every design decision names the row in the record
that forced it. That is the standard.

---

## Quick start

You need [Claude Code](https://claude.com/claude-code) installed and signed in. There
is no API key.

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/VedSoni-dev/primer/main/install.sh | sh
```

**Windows**

```bash
irm https://raw.githubusercontent.com/VedSoni-dev/primer/main/install.ps1 | iex
```

One file lands in `~/.local/bin` — the same directory Claude Code installs itself
into, so it is usually already on your PATH, and the installer tells you if it is
not. No Node, no npm, no build step, no admin rights. Uninstalling is deleting the
file.

```bash
primer start    # opens the parent app in your browser
primer demo     # optional: seed Ada, a six-year-old with history
```

In the app: add a child, tap **Prepare work**, approve what shows up, hand the tablet
over. Wi‑Fi sharing and tablet HTTPS are toggles on that same page — no flags to
memorize. Claude is reached through ACP when `claude-code-acp` is installed, otherwise
through the Claude Code CLI; either way it uses your existing login.

Open the URL. That is the whole interface for an adult: who your children are, what
is waiting for you to approve, and how they are doing.

```bash
primer tutor Ada    # plan her next session now
```

Claude reads her record and builds something for her. A minute or two later it lands
in the review queue. Approve it, and it appears on her page.

### The three screens an adult sees

Everything a child meets is generated fresh. Everything an adult sees is fixed and
boring on purpose — you should not have to relearn a layout each visit.

| | |
|---|---|
| **`/`** | Each child: what needs your attention, when they last worked, and a QR code to put their app on a tablet. |
| **`/review`** | What the tutor built and why, in plain words. Try it yourself, then approve or reject with a note. |
| **`/progress/<name>`** | What they finished, what is in flight, what is not clicking, the mix-ups being worked on, recordings of them reading, what the tutor knows they love, and any notes it left for you. |

### Every child gets their own app

A child's whole surface is one address — **`/k/ada`** — short enough to type on a
tablet, and it never changes. Open it on a phone or tablet and *Add to Home Screen*
and it becomes an installed app: **their name under the icon, their own colour, full
screen, no address bar.** Opening it always lands on whatever is waiting today rather
than on some activity they finished last week. If the connection drops mid-activity,
answers are held on the device and sent when it returns.

There is no menu inside it, no library, no chat box, and no route from it to another
child. The shell is the only part that repeats between children, and the shell is
almost nothing — everything inside was generated for one child and would make no
sense for another.

To put it on the tablet, run with `--lan` and point its camera at the QR code on the
parent home page:

```bash
primer start --lan
```

That binds to your whole network. The link in the QR code carries a key, and there is
one key per install rather than one per child — a device holding it can open any
child's activity page on this record. What the key separates is the child surface from
the adult one: the recordings, the progress notes, and the approval page are
unreachable over the network with any key and never leave this machine. Without `--lan`
nothing off-machine is served at all.

## Running it autonomously

Nobody should have to prompt a tutor. Two loops on different clocks:

**The fast loop — a child at play — never calls a model.** The interface is a
static HTML file that adapts using logic Claude baked in when it built the page. A
six-year-old cannot wait three seconds for a token stream, and you do not want a
live model path to a child.

**The slow loop runs between sessions.** Claude reads the record, decides, builds
tomorrow's activities, and queues them. The child opens their page; the right thing
is already sitting there.

**There is no API key.** The tutor runs through Claude Code — the same login you
already use interactively. primer shells out to `claude -p` and hands it the record
over primer's own MCP server. No key to mint, store, rotate, or leave lying in a
family's home directory.

```bash
primer doctor              # is Claude Code installed and signed in?
primer tutor Ada           # one planning cycle now
primer start --watch       # everything, planning on its own, forever
primer autostart on --lan  # and again after every reboot
```

`autostart` is the one that makes "runs on its own" true. Without it the tutor lives
only as long as a terminal window stays open, and no family leaves a terminal window
open. It installs a per-user login item — a LaunchAgent on macOS, a logon task on
Windows, a systemd user unit on Linux — and needs no administrator on any of them. On
Linux a user unit is torn down at logout unless `loginctl enable-linger` is set, which
primer tells you when it installs the unit. `primer autostart off` removes it;
`primer autostart status` says whether it is really running.

Two things it gets right that are easy to get wrong: the Windows task is configured
to run on battery (both relevant settings default to *don't*, so a laptop that boots
unplugged would otherwise never start it) and the macOS agent carries an explicit
`PATH`, because launchd hands an agent four system directories and none of them is
where Claude Code lives.

On Windows a console window belongs to the task — Node ships no windowless build.
Minimise it; closing it stops primer until the next login.

If `doctor` says you are not logged in, run `claude` once, sign in, and try again.
If the binary is not on your PATH, set `PRIMER_CLAUDE_BIN` to it.

### What the unattended run is allowed to touch

The invocation is deliberately narrow, and the test suite asserts each part of it:

```
claude -p --tools "" --strict-mcp-config --setting-sources ""
       --mcp-config <primer only>
       --allowedTools mcp__primer__learner_context,mcp__primer__save_interface,…
       --max-budget-usd <what's left today>
```

- `--tools ""` switches off **every** built-in tool. The tutor has no Bash, no
  file read or write, no web fetch. It cannot touch your disk or the network.
- `--strict-mcp-config` ignores whatever MCP servers you have configured for your
  own work. It reaches this record and nothing else.
- `--setting-sources ""` plus a replaced system prompt stops it inheriting `CLAUDE.md`,
  hooks, or plugins. A tutoring run must not pick up your repo's coding conventions.
  (Not `--bare`, which looks right and silently forces API-key auth, discarding the
  login this whole transport exists to use.)
- `--allowedTools` names the eighteen record tools it may call, and Claude Code
  denies the rest. Anything it reaches for outside that list is logged as a denial.
- `--max-budget-usd` is enforced by Claude Code itself, so the ceiling holds even
  if primer's own accounting is wrong.

`watch` checks every learner on an interval and mostly decides *not* to run. A run
happens when a session just ended, or when nothing is waiting. It refuses when a
backlog is already sitting untouched, when the last run was too recent, or when the
budget is gone. The failure mode of an always-on tutor is not running too rarely —
it is burning money generating a queue nobody opens.

```bash
primer check    # what it would do right now, and why it wouldn't
primer runs     # what it has been doing, and what each run cost
primer budget   # spend today and this month
```

### The adult stays in the loop

Every generated activity lands in `pending_review` and **no child can reach it until
someone approves it**. Open `/review`, read the tutor's rationale, click through the
activity yourself, approve or reject with a note — the note is read back on the next
planning run, so rejecting something teaches the tutor rather than just blocking it.

This is on by default. Turning it off is one command, and the change is written to
the audit log with who did it:

```bash
primer config review_required false
```

Cost is capped in two places. `daily_budget_usd` and `monthly_budget_usd` live in
the record and gate whether a run starts at all; whatever is left becomes the
`--max-budget-usd` Claude Code enforces on the run itself. Each run's tokens and
cost land in `agent_run`. Defaults are $1/day and $15/month.

On a Claude Code subscription there is no marginal charge, so the reported cost is
zero. primer falls back to a token-based estimate in that case, so the ceiling still
works as a usage guardrail rather than silently never triggering.

**What the autonomous loop cannot do:** create or delete learners, change
accommodations, or set goals. Those tools exist over MCP, where a human is asking
for them, and are deliberately absent from the unattended loop. If the tutor thinks
an accommodation is wrong, it writes a note and a human decides.

## Driving it by hand

The MCP server is the other front end — same tool implementations, same record, but
a human drives. Useful for working *with* a child live, or for asking questions
about the record.

```json
{
  "mcpServers": {
    "primer": {
      "command": "primer",
      "args": ["mcp"]
    }
  }
}
```

If `primer` is not on the PATH your client sees, give the absolute path to the
binary instead. From a source checkout it is `"command": "node"` with
`"args": ["/absolute/path/to/primer/dist/cli.js", "mcp"]`.

Claude Code users can skip the file:

```bash
claude mcp add primer -- primer mcp
```

Then say: *"Read Ada's record and plan a fifteen-minute session."*

Claude will call `learner_context`, find the short-e misconception, notice the two frustration
markers and the dinosaurs, write an interface, and hand you a URL. When she uses it, the
evidence comes back on its own.

## Try the reference interface

```bash
node --experimental-strip-types scripts/try-example.mjs
```

That script imports from `src/`, so it only runs in a source checkout, not from an
installed binary. It prints a URL. Open it, click through, then:

```bash
primer report Ada
```

The clicks are in the record.

---

## What's in the box

| | |
|---|---|
| **Open Learner Record** | 20-table SQLite schema. Evidence is append-only. Full spec in [SPEC.md](SPEC.md). |
| **Mastery model** | Bayesian Knowledge Tracing over a two-component forgetting curve. Recomputable from raw evidence at any time. |
| **Scheduler** | Ranks lapsed / due-for-review / stuck / frontier, spread across strands so a session is not eight vowel drills. |
| **Curriculum** | 213 skills, pre-K to grade 3, across reading, writing, math — with a prerequisite graph that crosses domains and probe templates instead of a fixed item bank. |
| **Recordings** | The child reading aloud, stored locally. Off until an adult turns it on. |
| **MCP server** | 28 tools. `learner_context` is the one that matters. Serves both the human-driven and unattended paths. |
| **Autonomous tutor** | Drives `claude -p` against that MCP server on a loop. Your Claude Code login, no API key. Queue, review gate, budget. |
| **Surface** | Localhost server. `/k/<name>` is the only URL a child needs; `/review` is the adult gate. |
| **Runtime** | ~340 lines injected into every generated page. `primer.observe(...)` and the loop closes itself. |

One runtime dependency: the MCP SDK. Storage is `node:sqlite`, built into Node 22+.
The model is reached through the `claude` binary you already have. Nothing phones home
on its own.

### The model, briefly

Mastery is not a percentage of worksheets completed. Each skill carries a BKT posterior —
"does she know this right now" — updated from every attempt, discounted for hints and for
effortful retrieval. On top sits a forgetting curve with two components: a fast one that
decays over days, and a floor that grows with successful repetitions and stops decaying,
because a child who could read CVC words in March has not returned to zero by September.

Half-life growth is driven by the **gap**, not the repetition count. Eight correct answers on
eight consecutive days is cramming and earns a few weeks of retention; the same eight spread
across widening gaps earns far more. Getting this backwards is how practice apps end up
certain a child knows something they last saw in spring.

Two rules keep the scheduler honest:

- **Using a skill refreshes what it is built on.** Reading a CVC word is practice of letter
  sounds whether or not anyone logged it. A correct answer restarts the clock on its
  prerequisites and stretches their interval; `p_known` is carried forward **unchanged**,
  because decay is a prediction about memory we cannot see, and watching the skill get used
  is seeing it. Wrong answers propagate nothing — a wrong answer is ambiguous about which
  layer broke. *(This code banked the decay instead for a while, which quietly ground
  constantly-used foundations toward zero: a child who had just read ten CVC words correctly
  sat at `p_known` 0.0005 on short vowel sounds. Real session data caught it, and because
  mastery is only a cache, `primer recompute` repaired the whole history.)*
- **Unobserved is not unknown.** A child adding within twenty has demonstrated counting to
  ten, and will never be formally assessed on it. Skills implied by downstream success are
  suppressed as targets and stop blocking their children.

### Hearing the child

Fluency is the one thing taps cannot measure. Whether a child reads in phrases or
word by word, whether they self-correct, where they hesitate — none of that survives
as a percentage. So a generated activity can ask a child to read aloud:

```js
const stop = await primer.listen({ prompt: 'Read this page out loud.', skill: 'fl_phrasing' });
// ...child reads...
await stop();
```

**It only works on the computer running primer — or on a tablet after one trust step.**
Browsers hand out the microphone only in a "secure context" — HTTPS, or localhost. A
tablet reaching primer at `http://192.168.x.x` is neither. Start with
`primer start --lan --https`: primer mints a private CA, serves activities over HTTPS,
and opens a second plain-HTTP port that only offers the CA certificate. Install that
certificate on the tablet once (the parent page walks through iPad and Android), then
scan the HTTPS QR. Without `--https`, primer detects the missing microphone and says so
on the progress page rather than letting a parent wonder why the setting did nothing.

The same limit removes the service worker until HTTPS is trusted, so **the offline cache
needs `--https` on a tablet too.** What does work everywhere is the evidence queue:
answers are held in the device's own storage and retried, so a dropped connection
mid-activity no longer loses what a child just did.

**Off by default.** Recording a child is never something software should assume:

```bash
primer config audio_capture true
```

The flag lives in the record, the change is written to the audit log with who made
it, and a generated page can never turn it on for itself — it asks the runtime, and
the runtime asks the setting. The browser's own microphone prompt is a second gate.
Audio is written next to the record on disk and never leaves the machine.

**The model cannot hear these. You can.** They appear on the progress page with a
play button, and what you notice goes back into the record as evidence
(`observation.kind = 'artifact_review'`) exactly like anything else. Set
`artifact_retention_days` if you want them pruned; deletion removes the file, not
just the row.

### Fitting the model to real children

The shipped BKT parameters — guess 0.20, slip 0.10, learn 0.20 — are a prior and
nothing more. They are identical for "names the letter B" and "subtracts across a
zero", which cannot be right: a two-choice question has a guess rate near 0.5.

```bash
primer fit           # what the evidence would say
primer fit --apply   # write it, then recompute
```

It estimates guess from first attempts before anyone taught the skill, slip from
errors after a learner has demonstrated it, and learn from how quickly the first
correct answer arrives. Each needs a real sample, and **with one child it will
refuse and tell you how far off it is.** That refusal is the point — a
fitted-looking number computed from eleven attempts is worse than an honest prior.
This is the part of the project that gets better as more families use it.

### Tools worth knowing

`learner_context` — the whole child in one call: mastery, what has slipped, misconceptions,
interests, accommodations, recent sessions, which of your past interfaces actually worked.
Read it first, every session.

`save_interface` — hand it a standalone HTML document, get back a URL. The runtime is injected
at serve time.

`note_misconception` — a stable wrong model, not a wrong answer. *"Reads every vowel as
short."* *"Thinks more digits always means bigger."* This is the highest-value thing in the
record and the thing every other system throws away in June.

`evidence_for` — the raw attempts behind any estimate, verbatim. When a parent asks "why does
it think that," this is the answer.

`export_record` — everything, as JSON. The family can leave whenever they want.

---

## Design commitments

**The record is the product; the interface is disposable.** Anything that makes the record
depend on a particular UI is a bug.

**Evidence over scores.** Every number is derived from observations kept forever. A better
model can always be applied retroactively — `recompute_mastery` replays the whole history.

**Local-first.** One file on the family's machine. Sync would be an extension; there is
none, and the core will never require one.

**The child never talks to a model.** They meet HTML someone approved. The model
works on the record, not on the child.

**No engagement machinery.** No streaks, coins, leaderboards, or countdown timers. A
twelve-minute session that ends on a win beats forty minutes that ends in tears, and the
record is not allowed to encode the opposite.

**Auditable and deletable.** Every write is logged with an actor.
`primer delete --learner <name> --yes` removes everything: every row, plus that child's
recordings and generated activities on disk, and it reports any file it could not
remove. Without `--yes` it only says what it would do.

## Development

```bash
npm test                      # 161 tests: model, record, surface, MCP protocol, security,
                              # packaging, deletion, activity validator, service descriptors,
                              # icons, QR, ACP permission boundary, LAN HTTPS
npm run dev -- targets Ada    # run from source, no build step (Node 22+ strips types)
npm run mcp                   # MCP server from source
```

`PRIMER_HOME` relocates the whole thing; `PRIMER_DB` points at a specific file;
`PRIMER_PORT` moves the surface off 7333.

Adding curriculum means adding JSON to `src/curriculum/` — a `domain`, a list of skills with
`prereq` edges and a `probe` template. Cross-domain prerequisites are supported and used
(spelling depends on phonics, because you cannot spell what you cannot segment). `loadCurriculum`
is idempotent and never touches a learner's evidence.

## Built to last

The design constraints that matter for something a family would use for a decade:

- **Forward-only migrations.** `schema.sql` is the baseline; every change after it is a
  numbered file in `src/db/migrations`, applied once inside a transaction and recorded
  in `applied_migration`. Nothing drops a column. Re-opening a record is idempotent.
- **Import as well as export.** `primer export` and `primer import` round-trip a full
  record — every observation, session, generated interface, and queued activity. On
  import every row gets a fresh id and all references are rewritten, so importing the
  same file twice makes two children rather than silently merging them, and the HTML
  travels with it, inlined. Audio does not: artifact rows are exported, but the recording
  files themselves stay on the machine that made them.
- **Mastery is a cache.** `recompute_mastery` replays the whole evidence history through
  the current model. When the model improves, the past improves with it.
- **Every write has an actor.** Including the settings that govern the autonomous loop.
  "Who turned off the review gate, and when" is a question the record can answer.

## Status

v0.1, and honest about it. The schema is stable enough to build on; the curriculum stops at
grade 3; the mastery parameters are principled defaults, not fitted to data.

**A real six-year-old has used this.** The full loop has run end to end with a child at
the keyboard: the tutor read her record, found a short-e/short-i substitution that four
sessions of minimal-pair drilling had not shifted, and refused to drill it again — it built
an activity where reading every `e` as `i` produces a sentence that is obviously wrong,
anchored to her dog's name. Her parent approved it. She played it. Ten observations came
back with verbatim answers and thinking times, the page closed its own session with a
summary and logged `pride`, and `ph_cvc_short_e` moved to mastered.

On the next run the tutor queued only one activity because the previous one was still
unopened, **distrusted its own mastery number** ("that came from tapping one of two words
already on screen, which has never been the part she struggles with"), retracted a
hearing-screen suggestion it had made when the evidence no longer supported it, and asked
the parent to try a low-tech check instead. None of that is prompted behavior; it fell out
of giving a model the whole child.

That session also surfaced the foundation-erosion bug described above, which no test had
caught. Tests now cover the model, scheduler, queue, review gate, budget, migrations,
audio capture, parameter fitting, the import round-trip, the security boundary, the
activity validator, the icon encoder, the auto-start descriptors, packaging, and
HTTPS with a locally-minted CA.

**What is still missing.** The curriculum stops at grade 3 and is English-only — a
content job, not an engineering one, and the most useful thing an outsider could
contribute. Nothing transcribes the audio, so a human has to listen. The parameter
fitting has never run on a real sample, because no such sample
exists. And every claim here rests on one child over one week; the honest sample size is one.

Tablet recording needs a one-time certificate install on each device
(`primer start --lan --https`); that is built, but it is still a multi-step trust flow
on iOS and Android, not silent.

The obvious next things after that: fitting BKT parameters per skill from real data, and
curriculum packs beyond grade 3 and beyond English.

Contributions welcome, especially from teachers and reading specialists. If the curriculum
graph is wrong somewhere, it is wrong in a way that will quietly mis-teach a real child, and
that is worth an issue.

## License

Apache-2.0.
