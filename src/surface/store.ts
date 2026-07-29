import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, one, run, id, now, logEvent, primerHome, parseJson } from '../db/index.ts';
import type { GeneratedInterface } from '../domain/types.ts';
import { settings } from '../agent/config.ts';
import { safeJson } from './security.ts';
import { RUNTIME_JS } from '../generated/assets.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export function interfacesDir(): string {
  const dir = join(primerHome(), 'interfaces');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runtimeSource(): string {
  for (const candidate of [
    join(HERE, 'runtime.js'),
    join(HERE, '..', '..', 'src', 'surface', 'runtime.js'),
  ]) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  return RUNTIME_JS;
}

export interface SaveInterfaceInput {
  title: string;
  html: string;
  kind?: string;
  spec?: unknown;
  target_skills?: string[];
}

/**
 * Persist an interface the tutor just wrote. Returns the id and the URL to open.
 * The HTML is stored verbatim; the runtime is injected at serve time so a stored
 * interface stays portable and re-openable even if the runtime changes.
 */
export function saveInterface(
  learnerId: string,
  input: SaveInterfaceInput,
): GeneratedInterface {
  const ifaceId = id('ifc');
  const path = join(interfacesDir(), `${ifaceId}.html`);
  writeFileSync(path, input.html, 'utf8');
  run(
    `INSERT INTO interface (id, learner_id, title, kind, path, spec, target_skills, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ifaceId,
    learnerId,
    input.title,
    input.kind ?? null,
    path,
    input.spec === undefined ? null : JSON.stringify(input.spec),
    input.target_skills ? JSON.stringify(input.target_skills) : null,
    now(),
  );
  logEvent('tutor:claude', 'save_interface', ifaceId, {
    title: input.title,
    bytes: input.html.length,
  });
  return getInterface(ifaceId)!;
}

export function getInterface(ifaceId: string): GeneratedInterface | undefined {
  return one<GeneratedInterface>(`SELECT * FROM interface WHERE id = ?`, ifaceId);
}

export function listInterfaces(learnerId: string, limit = 20): GeneratedInterface[] {
  return all<GeneratedInterface>(
    `SELECT * FROM interface WHERE learner_id = ? ORDER BY created_at DESC LIMIT ?`,
    learnerId,
    limit,
  );
}

export function readInterfaceHtml(iface: GeneratedInterface): string {
  return readFileSync(iface.path, 'utf8');
}

export function deleteInterface(ifaceId: string): void {
  const iface = getInterface(ifaceId);
  if (!iface) return;
  try {
    rmSync(iface.path, { force: true });
  } catch {
    /* file already gone */
  }
  run(`DELETE FROM interface WHERE id = ?`, ifaceId);
}

/**
 * Score an interface by what actually happened inside it: accuracy, volume of
 * engaged attempts, and the affect it produced. This is how the record learns
 * which designs reach this particular child.
 */
export function scoreInterface(ifaceId: string, note?: string): number | null {
  const iface = getInterface(ifaceId);
  if (!iface) return null;

  const stats = one<{ n: number; acc: number | null; median_gap: number | null }>(
    `SELECT count(*) AS n, avg(correct) AS acc, avg(latency_ms) AS median_gap
       FROM observation WHERE source = ? AND correct IS NOT NULL`,
    ifaceId,
  );
  const sessions = all<{ id: string }>(`SELECT id FROM session WHERE interface_id = ?`, ifaceId);
  const sessionIds = sessions.map((s) => s.id);

  let affectScore = 0.5;
  if (sessionIds.length) {
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = all<{ signal: string; total: number }>(
      `SELECT signal, sum(intensity) AS total FROM affect
        WHERE session_id IN (${placeholders}) GROUP BY signal`,
      ...sessionIds,
    );
    const good = rows
      .filter((r) => ['delight', 'flow', 'pride'].includes(r.signal))
      .reduce((a, r) => a + r.total, 0);
    const bad = rows
      .filter((r) => ['frustration', 'boredom', 'fatigue'].includes(r.signal))
      .reduce((a, r) => a + r.total, 0);
    if (good + bad > 0) affectScore = good / (good + bad);
  }

  const n = stats?.n ?? 0;
  if (n === 0 && sessionIds.length === 0) return null;

  // Accuracy near 0.8 is the sweet spot: too easy teaches nothing, too hard hurts.
  const acc = stats?.acc ?? 0.5;
  const challenge = 1 - Math.min(1, Math.abs(acc - 0.8) / 0.5);
  const volume = Math.min(1, n / 12);
  const score = Number((0.4 * affectScore + 0.35 * challenge + 0.25 * volume).toFixed(3));

  run(
    `UPDATE interface SET outcome_score = ?, outcome_note = coalesce(?, outcome_note),
            times_used = times_used + 1
      WHERE id = ?`,
    score,
    note ?? null,
    ifaceId,
  );
  return score;
}

/** Page shell: injects config + runtime into the tutor's HTML at serve time. */
export function renderInterface(
  iface: GeneratedInterface,
  ctx: { learner_id: string; session_id: string | null; api?: string },
): string {
  const html = readInterfaceHtml(iface);
  // safeJson escapes `<` — otherwise a value containing `</script>` closes this
  // block early and everything after it becomes markup.
  const head =
    `<script>window.__PRIMER__=${safeJson({
      learner_id: ctx.learner_id,
      session_id: ctx.session_id,
      interface_id: iface.id,
      target_skills: parseJson<string[]>(iface.target_skills, []),
      // Empty means "post back to wherever this page came from".
      //
      // Baking in an absolute origin here is a silent disaster: served over the
      // LAN to a tablet, `http://127.0.0.1:7333` resolves to the *tablet's* own
      // localhost, so every answer a child gives is posted into the void. The page
      // loads, the activity plays, the child finishes — and the record learns
      // nothing. Relative URLs are correct on localhost and on the LAN alike.
      api: ctx.api ?? '',
      audio_capture: settings().audio_capture,
    })};</script>\n<script src="/runtime.js"></script>\n`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`);
  }
  return head + html;
}
