import { writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { all, one, run, id, now, logEvent, primerHome, parseJson } from '../db/index.ts';

/**
 * The child's own work: audio of them reading, a photo of their handwriting, a
 * drawing they made.
 *
 * These never leave the machine. They are the most sensitive thing in the record
 * and the most valuable — a taped minute of a six-year-old reading tells you more
 * about fluency than a month of accuracy percentages, and in five years it is the
 * only part of this record a parent will want to open.
 */

export interface Artifact {
  id: string;
  learner_id: string;
  session_id: string | null;
  ts: string;
  kind: string;
  path: string;
  mime: string | null;
  mime_type: string | null;
  caption: string | null;
  skill_ids: string | null;
  duration_ms: number | null;
  prompt: string | null;
  transcript: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  bytes: number | null;
}

const EXTENSIONS: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

export function artifactsDir(): string {
  const dir = join(primerHome(), 'artifacts');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface SaveArtifactInput {
  kind: 'audio' | 'image' | 'writing' | 'drawing' | 'video';
  data: Buffer;
  mimeType: string;
  session_id?: string | null;
  caption?: string | null;
  prompt?: string | null;
  skill_ids?: string[];
  duration_ms?: number | null;
}

const MAX_BYTES = 25 * 1024 * 1024;

export function saveArtifact(learnerId: string, input: SaveArtifactInput): Artifact {
  if (input.data.length > MAX_BYTES) {
    throw new Error(`Artifact is ${Math.round(input.data.length / 1e6)}MB; the limit is 25MB.`);
  }
  const artifactId = id('art');
  const extension = EXTENSIONS[input.mimeType] ?? '.bin';
  const path = join(artifactsDir(), `${artifactId}${extension}`);
  writeFileSync(path, input.data);

  run(
    `INSERT INTO artifact
       (id, learner_id, session_id, ts, kind, path, mime, mime_type, caption, skill_ids,
        duration_ms, prompt, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    artifactId,
    learnerId,
    input.session_id ?? null,
    now(),
    input.kind,
    path,
    input.mimeType,
    input.mimeType,
    input.caption ?? null,
    input.skill_ids ? JSON.stringify(input.skill_ids) : null,
    input.duration_ms ?? null,
    input.prompt ?? null,
    input.data.length,
  );
  logEvent('interface', 'save_artifact', artifactId, {
    kind: input.kind,
    bytes: input.data.length,
    prompt: input.prompt,
  });
  return getArtifact(artifactId)!;
}

export function getArtifact(artifactId: string): Artifact | undefined {
  return one<Artifact>(`SELECT * FROM artifact WHERE id = ?`, artifactId);
}

export function listArtifacts(learnerId: string, limit = 20): Artifact[] {
  return all<Artifact>(
    `SELECT * FROM artifact WHERE learner_id = ? ORDER BY ts DESC LIMIT ?`,
    learnerId,
    limit,
  );
}

/** Artifacts no human has listened to yet. The review queue for a parent's ears. */
export function unreviewed(learnerId: string, limit = 10): Artifact[] {
  return all<Artifact>(
    `SELECT * FROM artifact WHERE learner_id = ? AND reviewed_at IS NULL
      ORDER BY ts DESC LIMIT ?`,
    learnerId,
    limit,
  );
}

/**
 * A human listened. What they heard becomes evidence like anything else — the
 * caller writes the observation; this just records that the artifact was reviewed
 * so it stops appearing in the queue.
 */
export function markReviewed(
  artifactId: string,
  by: string,
  opts: { transcript?: string; caption?: string } = {},
): Artifact | undefined {
  run(
    `UPDATE artifact SET reviewed_at = ?, reviewed_by = ?,
            transcript = coalesce(?, transcript), caption = coalesce(?, caption)
      WHERE id = ?`,
    now(),
    by,
    opts.transcript ?? null,
    opts.caption ?? null,
    artifactId,
  );
  logEvent(by, 'review_artifact', artifactId, opts);
  return getArtifact(artifactId);
}

export function deleteArtifact(artifactId: string): void {
  const artifact = getArtifact(artifactId);
  if (!artifact) return;
  try {
    rmSync(artifact.path, { force: true });
  } catch {
    /* already gone */
  }
  run(`DELETE FROM artifact WHERE id = ?`, artifactId);
  logEvent('cli', 'delete_artifact', artifactId);
}

/** Honor a retention setting, if the family set one. Deletion is real deletion. */
export function pruneArtifacts(retentionDays: number): number {
  if (!retentionDays || retentionDays <= 0) return 0;
  const stale = all<{ id: string }>(
    `SELECT id FROM artifact WHERE ts < datetime('now', ?)`,
    `-${retentionDays} days`,
  );
  for (const row of stale) deleteArtifact(row.id);
  return stale.length;
}

export function describeArtifact(a: Artifact) {
  return {
    id: a.id,
    kind: a.kind,
    recorded_at: a.ts,
    prompt: a.prompt,
    caption: a.caption,
    transcript: a.transcript,
    duration_seconds: a.duration_ms ? Math.round(a.duration_ms / 100) / 10 : null,
    reviewed: Boolean(a.reviewed_at),
    skills: parseJson<string[]>(a.skill_ids, []),
    // Relative so it works from wherever the surface is being served.
    url: `/artifacts/${basenameOf(a.path)}`,
    exists: existsSync(a.path),
    bytes: a.bytes ?? (existsSync(a.path) ? statSync(a.path).size : null),
  };
}

export function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function isAudio(a: Artifact): boolean {
  return a.kind === 'audio' || (a.mime_type ?? a.mime ?? '').startsWith('audio/');
}

export function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? extname(mimeType) ?? '.bin';
}
