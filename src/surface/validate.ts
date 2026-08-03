import { Script } from 'node:vm';
import {
  checkAccommodations,
  type ActiveAccommodation,
  type AccommodationFinding,
} from './accommodations.ts';

/**
 * Check a generated activity before a child can ever be shown it.
 *
 * The tutor writes real code and a real child runs it, unattended, with no adult
 * watching the console. A stray syntax error is not a stack trace to anyone — it
 * is a six-year-old staring at a blank screen deciding they are bad at reading.
 * That failure is silent, and it is the one this gate exists to stop.
 *
 * Errors block the activity from being saved at all, and the reason is handed back
 * to the tutor so it can fix and retry. Warnings are recorded for the adult but do
 * not block: this must not become a style police that refuses good work.
 */

export interface Finding {
  rule: string;
  message: string;
  hint?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  /**
   * Accommodations that could not be established from the source. Neither a
   * pass nor a failure, and shown to the adult reviewing the queue, because a
   * clean report on an unexamined constraint is how a reviewer is misled.
   */
  unverifiable: Finding[];
  stats: { bytes: number; scripts: number; observeCalls: number };
}

export interface ValidateOptions {
  /**
   * This child's standing instructions. Absent means nobody said, which is not
   * the same as nobody has any: `save_interface` always passes them, and a
   * caller that omits them gets no accommodation checking and is told nothing
   * about accommodations either way.
   */
  accommodations?: ActiveAccommodation[];
}

const MAX_BYTES = 400_000;

/** Anything that would make the page reach off the machine. */
const EXTERNAL_URL = /(?:src|href)\s*=\s*["']\s*(https?:)?\/\//i;
const EXTERNAL_FETCH = /(?:fetch|XMLHttpRequest|importScripts)\s*\(\s*["'`]\s*(?:https?:)?\/\//i;
const CSS_IMPORT = /@import\s+(?:url\()?["']?\s*(?:https?:)?\/\//i;

export function validateInterface(html: string, opts: ValidateOptions = {}): ValidationResult {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const unverifiable: Finding[] = [];

  const bytes = Buffer.byteLength(html, 'utf8');
  const scripts = extractScripts(html);
  const code = scripts.map(stripComments).join('\n');
  const observeCalls = countUses(code, 'observe');

  /* ------------------------------------------------------------ structure -- */

  if (!html.trim()) {
    errors.push({ rule: 'empty', message: 'The activity is empty.' });
    return { ok: false, errors, warnings, unverifiable, stats: { bytes, scripts: 0, observeCalls: 0 } };
  }

  if (!/<body[\s>]/i.test(html) && !/<html[\s>]/i.test(html)) {
    errors.push({
      rule: 'not_a_document',
      message: 'This is not a complete HTML document.',
      hint: 'Return a full page starting with <!doctype html>, including <html>, <head> and <body>.',
    });
  }

  if (bytes > MAX_BYTES) {
    errors.push({
      rule: 'too_large',
      message: `The page is ${Math.round(bytes / 1024)}KB; the limit is ${MAX_BYTES / 1024}KB.`,
      hint: 'Inline images are the usual cause. Prefer emoji, CSS shapes, or inline SVG.',
    });
  }

  /* -------------------------------------------------------- self-contained -- */

  // The record is local-first and the tablet may be offline. A page that needs a
  // CDN is a page that fails in a waiting room.
  if (EXTERNAL_URL.test(html) || EXTERNAL_FETCH.test(html) || CSS_IMPORT.test(html)) {
    const sample = (html.match(EXTERNAL_URL) ?? html.match(EXTERNAL_FETCH) ?? html.match(CSS_IMPORT))![0];
    errors.push({
      rule: 'external_request',
      message: `The page loads something from the internet: ${sample.trim().slice(0, 60)}`,
      hint: 'Everything must be inline — no CDNs, no web fonts, no remote images. It has to work offline.',
    });
  }

  /* ------------------------------------------------------ syntax of scripts -- */

  scripts.forEach((code, index) => {
    if (!code.trim()) return;
    try {
      // Compiles without running. Catches exactly the class of mistake that
      // otherwise reaches a child as a blank screen.
      new Script(code, { filename: `activity-script-${index + 1}.js` });
    } catch (err) {
      errors.push({
        rule: 'javascript_syntax',
        message: `Script ${index + 1} does not parse: ${(err as Error).message}`,
        hint: 'A page with a syntax error shows a child nothing at all.',
      });
    }
  });

  /* ------------------------------------------------------- instrumentation -- */

  if (observeCalls === 0) {
    errors.push({
      rule: 'reports_nothing',
      message: 'The activity never calls primer.observe(), so nothing a child does is recorded.',
      hint:
        'Call primer.observe({skill, correct, item, response, expected}) on every attempt. ' +
        'An activity that reports nothing teaches the record nothing, and the next session ' +
        'will be planned as blind as this one.',
    });
  }

  if (countUses(code, 'done') === 0) {
    warnings.push({
      rule: 'never_ends',
      message: 'The activity never calls primer.done().',
      hint: 'Without it the session stays open and no summary is written.',
    });
  }

  if (countUses(code, 'affect') === 0) {
    warnings.push({
      rule: 'no_affect',
      message: 'Nothing reports how it felt — no primer.affect() call.',
      hint: 'Frustration and delight shape the next session more than accuracy does.',
    });
  }

  /* ---------------------------------------------------------- child-facing -- */

  if (!/<meta[^>]+viewport/i.test(html)) {
    warnings.push({
      rule: 'no_viewport',
      message: 'No viewport meta tag; this will render tiny on a tablet.',
      hint: '<meta name="viewport" content="width=device-width,initial-scale=1">',
    });
  }

  if (!/<html[^>]+lang=/i.test(html)) {
    warnings.push({ rule: 'no_lang', message: 'No lang attribute on <html>.' });
  }

  // Countdown timers are the single most common accommodation violation, and the
  // tutor cannot be trusted to remember every time.
  if (/setInterval\s*\([^)]*\)/.test(html) && /\b(countdown|timeLeft|secondsLeft|timer)\b/i.test(html)) {
    warnings.push({
      rule: 'possible_timer',
      message: 'This looks like it may contain a countdown timer.',
      hint: 'Check the child has no "no_timers" accommodation before approving.',
    });
  }

  if (/\b(eval|new\s+Function)\s*\(/.test(html)) {
    warnings.push({
      rule: 'dynamic_code',
      message: 'The page builds and runs code at runtime (eval or new Function).',
    });
  }

  if (/document\.write\s*\(/.test(html)) {
    warnings.push({ rule: 'document_write', message: 'document.write() can blank the page after load.' });
  }

  if (scripts.length === 0) {
    errors.push({
      rule: 'no_script',
      message: 'The page has no script, so it cannot respond to a child or record anything.',
    });
  }

  /* ------------------------------------------------------ accommodations -- */

  // SPEC.md calls these a hard constraint rather than a hint, so a violation
  // blocks the save the same way a syntax error does. The tutor is told what it
  // broke and retries; a child never meets the version that ignored them.
  if (opts.accommodations?.length) {
    const acc = checkAccommodations(html, opts.accommodations);
    const asFinding = (f: AccommodationFinding): Finding => ({
      rule: `accommodation:${f.rule}`,
      message: f.message,
      hint: f.hint,
    });
    errors.push(...acc.errors.map(asFinding));
    warnings.push(...acc.warnings.map(asFinding));
    unverifiable.push(...acc.unverifiable.map(asFinding));
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    unverifiable,
    stats: { bytes, scripts: scripts.length, observeCalls },
  };
}

/** Inline script bodies only; a src= script is caught by the external-request rule. */
function extractScripts(html: string): string[] {
  const out: string[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const attrs = match[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    // Only real JavaScript: skip templates, JSON-LD, and the like.
    const type = attrs.match(/type\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (type && !/javascript|module|^$/.test(type)) continue;
    out.push(match[2] ?? '');
  }
  return out;
}

/**
 * Does the code use this part of the runtime at all?
 *
 * Matching `.observe(` is not enough, and getting this wrong is worse than not
 * checking: a real generated activity aliased the whole API up front —
 * `var pObserve = safe("observe")`, then `pObserve(...)` throughout — which is
 * perfectly good defensive code, and a naive check would have rejected it and
 * told the tutor its working page recorded nothing.
 *
 * So look for the name as an identifier or string anywhere in the script, with
 * comments stripped first. This errs toward accepting: a page that merely mentions
 * `observe` in passing slips through, which costs far less than refusing good work.
 */
function countUses(code: string, name: string): number {
  const uses = code.match(new RegExp(`\\b${name}\\b`, 'g'));
  return uses ? uses.length : 0;
}

/** Rough but adequate: keeps a commented-out call from counting as instrumentation. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/** A short, plain explanation for the tutor to act on. */
export function explain(result: ValidationResult): string {
  const lines: string[] = [];
  if (result.errors.length) {
    lines.push('This activity was not saved. Fix these and call save_interface again:');
    for (const e of result.errors) lines.push(`  - ${e.message}${e.hint ? ` ${e.hint}` : ''}`);
  }
  if (result.warnings.length) {
    lines.push(result.errors.length ? 'Also worth fixing:' : 'Saved, but worth knowing:');
    for (const w of result.warnings) lines.push(`  - ${w.message}${w.hint ? ` ${w.hint}` : ''}`);
  }
  if (result.unverifiable?.length) {
    // Said plainly, because the difference between "checked and fine" and "not
    // checked" is the whole value of reporting it at all.
    lines.push('Not checked, and an adult has to look:');
    for (const u of result.unverifiable) lines.push(`  - ${u.message}${u.hint ? ` ${u.hint}` : ''}`);
  }
  return lines.join('\n');
}
