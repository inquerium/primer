#!/usr/bin/env node

// Checked before anything imports the database layer. `node:sqlite` does not exist
// before 22.5 and needs a flag until 22.13, and the failure is a raw
// ERR_UNKNOWN_BUILTIN_MODULE stack trace thrown during module resolution — before
// main() exists to catch it. A parent on an older Node deserves a sentence, not that.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major! < 22 || (major === 22 && minor! < 13)) {
  console.error(
    `primer needs Node 22.13 or newer; this is ${process.versions.node}.\n` +
      `Node 22 and 24 are both fine — https://nodejs.org has the installer.`,
  );
  process.exit(1);
}

import { writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { db, dbPath, primerHome, all, one, run, tx } from './db/index.ts';
import { loadCurriculum } from './curriculum/load.ts';
import { createLearner, listLearners, resolveLearner, forgetLearner } from './record/learners.ts';
import { learnerContext } from './record/context.ts';
import { nextTargets } from './domain/scheduler.ts';
import { progressReport, exportRecord, importRecord } from './record/report.ts';
import { queue, pendingReview, approve, reject, restoreAbandoned } from './record/queue.ts';
import { closeStaleSessions } from './record/observations.ts';
import { runTutor, recentRuns } from './agent/tutor.ts';
import { decide, watch } from './agent/daemon.ts';
import { settings, setSetting, budget } from './agent/config.ts';
import { runClaudeCode, claudeBinary, isPackaged } from './agent/claude-code.ts';
import { transportStatus } from './agent/acp.ts';
import { fitParameters, exportContribution } from './domain/fit.ts';
import { lanAddresses } from './surface/pwa.ts';
import { installService, uninstallService, serviceStatus } from './agent/service.ts';
import { pruneArtifacts, listArtifacts, describeArtifact } from './record/artifacts.ts';
import { recompute } from './record/mastery.ts';
import { createSurfaceServer } from './surface/server.ts';
import { startMcpServer } from './mcp/server.ts';
import { TUTOR_PROMPT } from './mcp/prompt.ts';
import { seedDemo } from './demo.ts';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';

function flag(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1];
  return fallback;
}

function has(name: string): boolean {
  return argv.includes(`--${name}`);
}

/** CLI flags win; otherwise remember what the parent app last asked for. */
function surfaceFlags(): { lan: boolean; https: boolean } {
  const conf = settings();
  let lan = has('lan') || (!has('no-lan') && conf.surface_lan);
  let https = has('https') || (!has('no-https') && conf.surface_https);
  if (https) lan = true;
  return { lan, https };
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* parent can open the URL themselves */
  }
}

function positional(n: number): string | undefined {
  const rest = argv.slice(1).filter((a) => !a.startsWith('--'));
  // drop values consumed by flags
  const consumed = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith('--') && argv[i + 1] && !argv[i + 1]!.startsWith('--')) {
      consumed.add(argv[i + 1]!);
    }
  }
  return rest.filter((a) => !consumed.has(a))[n];
}

function out(value: unknown): void {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

const HELP = `primer — an open learner record

  primer start                      open the parent app in your browser
                                    [--watch] [--lan] [--https] [--every 30] [--port 7333]
                                    (or turn Wi‑Fi / HTTPS on from the app itself)

  Everything else is optional power-user surface. The app is the product.

  primer init                       create the record and load the built-in curriculum
  primer learners                   list children in the record
  primer learner:add <name>         add a child   [--birth ISO] [--pronouns she/her]
  primer context <learner>          everything a tutor needs, as JSON
  primer targets <learner>          what to work on next, and why  [--domain reading]
  primer report <learner>           progress summary  [--days 30]
  primer export <learner>           full record as JSON  [--out record.json]
  primer recompute <learner>        rebuild mastery from raw evidence
  primer curriculum:load [dir]      load or reload skill packs
  primer serve                      run the interface surface  [--port 7333]
  primer mcp                        run the MCP server (for a human driving Claude)
  primer prompt                     print the tutor operating instructions
  primer demo                       seed a realistic example child to poke at
  primer where                      show where the record lives

Autonomous tutor — runs through your Claude Code login, no API key:
  primer autostart [on|off|status]  start automatically when you log in  [--lan] [--https]
  primer doctor                     check Claude Code is installed and signed in
  primer tutor <learner>            run one planning cycle now  [--dry-run] [--max-usd 0.50]
  primer watch                      run the tutor on a loop  [--every 30] [--port 7333]
  primer check                      what the tutor would do right now, and why
  primer queue <learner>            what is waiting for this child
  primer review                     approve or reject queued activities
  primer runs [learner]             what the tutor has been doing, and what it cost
  primer budget                     spend today and this month
  primer config [key] [value]       show or change settings
  primer fit                        fit skill parameters to real evidence  [--apply]
  primer fit --export-contribution  write this install's counts, for sharing  [--out]
  primer recordings <learner>       audio and work the child has produced
  primer import <file.json>         load a record exported from another install
  primer delete --learner <name>    erase a child: every row, every recording  [--yes]

Record: ${dbPath()}
`;

async function main(): Promise<void> {
  switch (command) {
    case 'init': {
      db();
      const result = loadCurriculum();
      out({ record: dbPath(), ...result });
      out(`\nNext: primer demo   (or: primer learner:add "Ada")`);
      break;
    }

    case 'learners':
      out(listLearners());
      break;

    case 'learner:add': {
      const name = positional(0);
      if (!name) throw new Error('usage: primer learner:add "Name" [--birth 2019-04-01]');
      db();
      out(
        createLearner({
          display_name: name,
          birth_date: flag('birth'),
          pronouns: flag('pronouns'),
          locale: flag('locale'),
          timezone: flag('timezone'),
        }),
      );
      break;
    }

    case 'context': {
      const learner = resolveLearner(positional(0) ?? '');
      const domain = flag('domain');
      out(learnerContext(learner.id, domain ? { domains: [domain as never] } : {}));
      break;
    }

    case 'targets': {
      const learner = resolveLearner(positional(0) ?? '');
      const domain = flag('domain');
      const targets = nextTargets(learner.id, {
        domains: domain ? [domain as never] : undefined,
        limit: Number(flag('limit', '10')),
      });
      if (has('json')) {
        out(targets);
        break;
      }
      for (const t of targets) {
        out(
          `${t.priority.toFixed(2)}  ${t.reason.padEnd(11)} ${String(t.p_known).padEnd(6)} ` +
            `${t.skill.domain}/${t.skill.strand}  ${t.skill.name}  (${t.skill.id})`,
        );
      }
      break;
    }

    case 'report': {
      const learner = resolveLearner(positional(0) ?? '');
      out(progressReport(learner.id, Number(flag('days', '30'))));
      break;
    }

    case 'export': {
      const learner = resolveLearner(positional(0) ?? '');
      const data = exportRecord(learner.id);
      const target = flag('out');
      if (target) {
        writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
        out(`wrote ${target}`);
      } else {
        out(data);
      }
      break;
    }

    case 'recompute': {
      const learner = resolveLearner(positional(0) ?? '');
      out({ skills_recomputed: recompute(learner.id) });
      break;
    }

    case 'curriculum:load': {
      db();
      out(loadCurriculum(positional(0)));
      break;
    }

    case 'serve': {
      const surface = await createSurfaceServer(Number(flag('port', '7333')), {
        lan: has('lan'),
        https: has('https'),
      });
      await surface.listen();
      out(`primer surface on ${surface.origin}  (record: ${dbPath()})`);
      break;
    }

    case 'mcp':
      await startMcpServer();
      break;

    case 'prompt':
      out(TUTOR_PROMPT);
      break;

    case 'demo': {
      db();
      loadCurriculum();
      out(seedDemo(flag('name', 'Ada')!));
      break;
    }

    /* ------------------------------------------------- autonomous tutor -- */

    case 'tutor': {
      const learner = resolveLearner(positional(0) ?? '');
      const port = Number(flag('port', '7333'));
      // Hold the port so generated URLs point at a surface that stays up after
      // the run; the spawned MCP server reuses it rather than binding its own.
      const surface = await createSurfaceServer(port, { lan: has('lan'), https: has('https') });
      await surface.listen().catch(() => {});
      const result = await runTutor(learner.id, {
        trigger: 'manual',
        surfacePort: port,
        dryRun: has('dry-run'),
        maxBudgetUsd: flag('max-usd') ? Number(flag('max-usd')) : undefined,
      });
      out(result.summary);
      out(
        `\n[${result.status}] ${result.activities_planned} queued · ${result.turns} turns · ` +
          `$${result.cost_usd.toFixed(4)}`,
      );
      if (result.activities_planned > 0 && settings().review_required) {
        out(`Waiting for your approval: ${surface.origin}/review`);
      }
      await surface.close();
      break;
    }

    /**
     * The one command someone should have to learn. Sets the record up if it is
     * not, starts the surface, checks Claude Code, and prints one URL.
     */
    case 'start': {
      db();
      const skills = all<{ n: number }>(`SELECT count(*) AS n FROM skill`)[0]!.n;
      if (skills === 0) {
        const loaded = loadCurriculum();
        out(`Loaded ${loaded.skills} skills.`);
      }

      const port = Number(flag('port', '7333'));
      const { lan, https } = surfaceFlags();
      const surface = await createSurfaceServer(port, { lan, https });
      try {
        await surface.listen();
      } catch {
        out(`Something is already using port ${port}. Try: primer start --port 7334`);
        break;
      }

      out(`\nprimer is open at ${surface.origin}`);
      openBrowser(surface.origin);
      out(`(opened in your browser — that window is the whole app)`);

      const how = transportStatus();
      out(`tutor transport: ${how.transport} — ${how.note}`);

      if (lan) {
        const scheme = https ? 'https' : 'http';
        for (const address of lanAddresses()) {
          out(`  tablet: ${scheme}://${address}:${port}`);
        }
        if (https && surface.caPort) {
          out(`  certificate: http://<wifi-ip>:${surface.caPort}/ca.cer`);
        }
      }

      const children = listLearners();
      if (children.length) {
        const waiting = pendingReview().length;
        out(
          `\n${children.length} child${children.length === 1 ? '' : 'ren'}` +
            (waiting ? ` · ${waiting} waiting for review` : ''),
        );
      }

      if (has('watch')) {
        const every = Number(flag('every', '30'));
        out(`Planning automatically every ${every} minutes.`);
        watch({
          intervalMinutes: every,
          surfacePort: port,
          onTick: (r) => {
            for (const run of r.ran) {
              out(`  ${run.status} · ${run.activities_planned} queued · ${run.summary.split('\n')[0]}`);
            }
          },
        });
      } else {
        out(`\nLeave this running. Ctrl-C to stop.`);
      }
      await new Promise(() => {});
      break;
    }

    case 'autostart': {
      const action = positional(0) ?? 'on';
      if (action === 'off') {
        for (const line of uninstallService().messages) out(line);
        break;
      }
      if (action === 'status') {
        const status = serviceStatus();
        out(`${status.installed ? 'installed' : 'not installed'} — ${status.detail}`);
        break;
      }
      const result = installService({
        port: Number(flag('port', '7333')),
        lan: has('lan'),
        https: has('https'),
        everyMinutes: Number(flag('every', '30')),
      });
      for (const line of result.messages) out(line);
      if (result.ok) out(`\nCheck it any time with: primer autostart status`);
      break;
    }

    case 'doctor': {
      const bin = claudeBinary();
      out(`record:       ${dbPath()}`);
      out(`claude:       ${bin}`);
      const probe = await runClaudeCode({
        prompt: 'Reply with the single word: ready',
        systemPrompt: 'You are a health check. Reply with one word and nothing else.',
        maxTurns: 1,
        maxBudgetUsd: 0.05,
        timeoutMs: 120_000,
      });
      if (probe.ok) {
        out(`claude code:  logged in and answering ("${probe.text.slice(0, 40)}")`);
        out(`\nReady. Try: primer tutor <learner>`);
      } else {
        out(`claude code:  ${probe.text}`);
        if (probe.failure === 'not_logged_in') out(`\nFix: run \`claude\` once and sign in.`);
        if (probe.failure === 'not_installed') {
          out(`\nFix: install Claude Code, or set PRIMER_CLAUDE_BIN to its path.`);
        }
      }
      break;
    }

    case 'check': {
      for (const learner of listLearners()) {
        const d = decide(learner.id);
        out(`${d.trigger ? `RUN  (${d.trigger})` : 'skip'}  ${d.name} — ${d.reason}`);
      }
      const b = budget();
      out(
        `\nbudget: $${b.spent_today.toFixed(2)}/$${b.daily_budget.toFixed(2)} today · ` +
          `$${b.spent_this_month.toFixed(2)}/$${b.monthly_budget.toFixed(2)} this month`,
      );
      break;
    }

    case 'watch': {
      const surface = await createSurfaceServer(Number(flag('port', '7333')), {
        lan: has('lan'),
        https: has('https'),
      });
      await surface.listen();
      const every = Number(flag('every', '30'));
      out(`primer watching. surface ${surface.origin} · checking every ${every} min · record ${dbPath()}`);
      watch({
        intervalMinutes: every,
        surfacePort: surface.port,
        onTick: (r) => {
          const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
          for (const run of r.ran) {
            out(`${stamp}  ${run.status} · ${run.activities_planned} queued · $${run.cost_usd.toFixed(4)} · ${run.summary.split('\n')[0]}`);
          }
          if (r.budget_exhausted) out(`${stamp}  budget reached — paused until it resets`);
        },
      });
      await new Promise(() => {}); // run until killed
      break;
    }

    case 'queue': {
      const learner = resolveLearner(positional(0) ?? '');
      // Anything opened but never finished, with nothing recorded, goes back in the
      // queue rather than being silently lost.
      const restored = restoreAbandoned(learner.id);
      const closed = closeStaleSessions();
      if (restored) out(`Put ${restored} unfinished activit${restored === 1 ? 'y' : 'ies'} back in the queue.`);
      if (closed) out(`Closed ${closed} session${closed === 1 ? '' : 's'} that were left open.\n`);

      const items = queue(learner.id, ['pending_review', 'ready', 'delivered']);
      if (!items.length) {
        out(`Nothing queued for ${learner.display_name}.`);
        break;
      }
      for (const a of items) {
        out(`${a.status.padEnd(15)} ${a.title}`);
        if (a.rationale) out(`                ${a.rationale}`);
      }
      break;
    }

    case 'review': {
      const items = pendingReview();
      if (!items.length) {
        out('Nothing waiting for approval.');
        break;
      }
      const approveAll = flag('approve');
      const rejectId = flag('reject');
      if (approveAll) {
        approve(approveAll, 'parent', flag('note'));
        out(`approved ${approveAll}`);
        break;
      }
      if (rejectId) {
        reject(rejectId, 'parent', flag('note'));
        out(`rejected ${rejectId}`);
        break;
      }
      for (const a of items) {
        out(`${a.id}  ${a.title}`);
        if (a.rationale) out(`  why: ${a.rationale}`);
      }
      out(`\nprimer review --approve <id> [--note "..."]   (or open the page: primer serve, then /review)`);
      break;
    }

    case 'runs': {
      const ref = positional(0);
      const learner = ref ? resolveLearner(ref) : null;
      const rows = recentRuns(learner?.id, Number(flag('limit', '15'))) as any[];
      for (const r of rows) {
        out(
          `${r.started_at.slice(0, 16).replace('T', ' ')}  ${String(r.status).padEnd(11)} ` +
            `${String(r.activities).padStart(2)} queued  $${Number(r.cost_usd).toFixed(4)}  ${r.summary ?? ''}`,
        );
      }
      if (!rows.length) out('No runs yet.');
      break;
    }

    case 'budget':
      out(budget());
      break;

    case 'fit': {
      if (has('export-contribution')) {
        const contribution = exportContribution();
        const target = flag('out');
        if (target) {
          writeFileSync(target, JSON.stringify(contribution, null, 2), 'utf8');
          out(`wrote ${target} — ${contribution.skills.length} skills, counts only`);
        } else {
          out(contribution);
        }
        out(
          `\nThis file has no learner name, no responses, no timestamps — just how many\n` +
            `attempts each skill has seen here. Nothing was sent anywhere; what you do\n` +
            `with the file is up to you.`,
        );
        break;
      }
      const result = fitParameters({
        minSamples: Number(flag('min-samples', '30')),
        apply: has('apply'),
      });
      if (!result.fitted.length) {
        out(
          `No skill has enough evidence to fit yet (needs ${result.min_samples} of each kind).`,
        );
        const closest = result.skipped
          .filter((s) => s.samples.first_attempts > 0)
          .sort((a, b) => b.samples.first_attempts - a.samples.first_attempts)
          .slice(0, 5);
        if (closest.length) {
          out(`\nClosest so far:`);
          for (const s of closest) out(`  ${s.name} — ${s.why_not}`);
        }
        out(
          `\nThe defaults stay. A number fitted from a handful of attempts is worse\n` +
            `than an honest prior — this needs many children, or one child over years.`,
        );
        break;
      }
      for (const f of result.fitted) {
        out(
          `${f.name}\n  guess ${f.current.p_guess} -> ${f.fitted!.p_guess}` +
            `   slip ${f.current.p_slip} -> ${f.fitted!.p_slip}` +
            `   learn ${f.current.p_learn} -> ${f.fitted!.p_learn}`,
        );
      }
      out(
        result.applied
          ? `\nApplied to ${result.fitted.length} skills. Run \`primer recompute <learner>\` to rebuild mastery on the new parameters.`
          : `\n${result.fitted.length} skills could be fitted. Re-run with --apply to write them.`,
      );
      break;
    }

    case 'config': {
      const key = positional(0);
      const value = positional(1);
      if (!key) {
        out(settings());
        break;
      }
      if (value === undefined) {
        out({ [key]: (settings() as any)[key] });
        break;
      }
      setSetting(key as never, value);
      out(`${key} = ${value}`);
      break;
    }

    case 'recordings': {
      const learner = resolveLearner(positional(0) ?? '');
      const clips = listArtifacts(learner.id, Number(flag('limit', '20'))).map(describeArtifact);
      if (!clips.length) {
        out(
          settings().audio_capture
            ? `Nothing recorded yet for ${learner.display_name}.`
            : `Recording is off. Turn it on with: primer config audio_capture true`,
        );
        break;
      }
      for (const c of clips) {
        out(
          `${c.recorded_at.slice(0, 16).replace('T', ' ')}  ${c.kind.padEnd(7)} ` +
            `${c.duration_seconds ? `${c.duration_seconds}s` : ''}  ${c.reviewed ? 'heard' : 'NOT HEARD'}  ` +
            `${c.prompt ?? ''}`,
        );
      }
      const pruned = pruneArtifacts(settings().artifact_retention_days);
      if (pruned) out(`\nRemoved ${pruned} past the retention limit.`);
      break;
    }

    case 'import': {
      const file = positional(0);
      if (!file) throw new Error('usage: primer import <file.json>');
      db();
      out(importRecord(JSON.parse(readFileSync(file, 'utf8'))));
      break;
    }

    case 'where':
      out({
        home: primerHome(),
        record: dbPath(),
        skills: all(`SELECT count(*) AS n FROM skill`)[0],
        // Worth printing: it decides how the tutor re-launches primer as its own
        // MCP server, and it is the first thing to check in a bug report.
        build: isPackaged() ? 'standalone binary' : 'node',
        node: process.version,
      });
      break;

    case 'delete': {
      const ref = flag('learner');
      if (!ref) throw new Error('usage: primer delete --learner <id|name> --yes');
      const learner = resolveLearner(ref);
      if (!has('yes')) {
        // Say what will go, by count, before it goes. "All evidence" is abstract;
        // "9 recordings" is the thing someone actually needs to think about.
        const counts = one<{ obs: number; art: number; ifc: number }>(
          `SELECT (SELECT count(*) FROM observation o JOIN session s ON o.session_id = s.id
                    WHERE s.learner_id = ?) AS obs,
                  (SELECT count(*) FROM artifact WHERE learner_id = ?) AS art,
                  (SELECT count(*) FROM interface WHERE learner_id = ?) AS ifc`,
          learner.id,
          learner.id,
          learner.id,
        );
        out(`This permanently deletes ${learner.display_name} (${learner.id}):`);
        out(`  ${counts?.obs ?? 0} recorded attempts`);
        out(`  ${counts?.art ?? 0} recordings, deleted from disk`);
        out(`  ${counts?.ifc ?? 0} generated activities, deleted from disk`);
        out(`This cannot be undone. Re-run with --yes to confirm.`);
        break;
      }
      const gone = forgetLearner(learner.id);
      out(
        `deleted ${gone.learner} — ${gone.artifacts} recordings and ${gone.interfaces} activities removed from disk`,
      );
      if (gone.files_left_behind.length) {
        out(`could not remove these files; delete them yourself:`);
        for (const path of gone.files_left_behind) out(`  ${path}`);
      }
      break;
    }

    default:
      out(HELP);
  }
}

main().catch((err) => {
  console.error(`primer: ${(err as Error).message}`);
  process.exit(1);
});
