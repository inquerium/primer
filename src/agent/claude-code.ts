import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { primerHome, dbPath } from '../db/index.ts';

/**
 * Drive the tutor through the Claude Code CLI rather than the API.
 *
 * The point is whose credentials are used: Claude Code already knows who the
 * operator is. No API key to mint, store, rotate, or leak into a family's home
 * directory — the same login that runs `claude` interactively runs the tutor
 * overnight.
 *
 * Claude Code talks to the record over primer's own MCP server, so there is one
 * tool table and one transport for both the human-driven and unattended paths.
 * The tools an unattended run may call are named explicitly, and every built-in
 * tool is switched off.
 */

/** The only tools the unattended tutor may call. Everything else is denied. */
export const AUTONOMOUS_TOOLS = [
  'learner_context',
  'next_targets',
  'skill_search',
  'skill_detail',
  'evidence_for',
  'list_interfaces',
  'get_interface_html',
  'save_interface',
  'plan_activity',
  'queue_status',
  'list_artifacts',
  'record_artifact_review',
  'record_observations',
  'note_misconception',
  'resolve_misconception',
  'note_interest',
  'note_affect',
  'add_note',
] as const;

export interface ClaudeCodeOptions {
  prompt: string;
  systemPrompt: string;
  model?: string;
  effort?: string;
  /** Hard ceiling handed to Claude Code itself, in dollars. */
  maxBudgetUsd?: number;
  maxTurns?: number;
  timeoutMs?: number;
  /** Port the MCP server's surface should bind to inside the child process. */
  surfacePort?: number;
  signal?: AbortSignal;
}

export interface ClaudeCodeResult {
  ok: boolean;
  text: string;
  cost_usd: number;
  turns: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  };
  /** Set when the run failed for a reason the operator needs to act on. */
  failure?: 'not_logged_in' | 'not_installed' | 'timeout' | 'bad_output' | 'error';
  denials: unknown[];
  raw?: unknown;
}

/**
 * Find the `claude` binary, by absolute path where possible.
 *
 * Relying on the name alone breaks in two ways that both look like "primer is
 * broken". A background agent on macOS gets launchd's PATH — `/usr/bin:/bin:
 * /usr/sbin:/sbin` — which does not contain `~/.local/bin`, where the official
 * installer puts it. And an npm install on Windows produces `claude.cmd`, which
 * Node has refused to spawn without a shell since the CVE-2024-27980 fix, failing
 * with a bare EINVAL.
 */
let cachedBinary: string | null = null;

export function claudeBinary(): string {
  if (process.env.PRIMER_CLAUDE_BIN) return process.env.PRIMER_CLAUDE_BIN;
  if (cachedBinary) return cachedBinary;

  const home = homedir();
  const windows = process.platform === 'win32';
  const candidates = windows
    ? [
        join(home, '.local', 'bin', 'claude.exe'),
        join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
        join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      ]
    : [
        join(home, '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        join(home, '.npm-global', 'bin', 'claude'),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBinary = candidate;
      return candidate;
    }
  }
  // Fall back to the bare name and let PATH decide.
  cachedBinary = windows ? 'claude.exe' : 'claude';
  return cachedBinary;
}

/**
 * Where primer's own CLI lives, so the spawned Claude Code can start the MCP
 * server that talks to this exact record.
 */
function primerEntry(): { command: string; args: string[] } {
  // Packaged as a single binary there is no script to point at: the executable is
  // primer, and `process.argv[1]` is the executable itself. Passing it as an
  // argument would tell it to run a command named after its own path.
  if (isPackaged()) return { command: process.execPath, args: ['mcp'] };

  const entry = process.env.PRIMER_ENTRY ?? process.argv[1] ?? '';
  // Running from source on Node 22.x needs the flag; on 24+ it is the default
  // and harmless. Built output never hits this branch.
  const args = entry.endsWith('.ts') ? ['--experimental-strip-types', entry, 'mcp'] : [entry, 'mcp'];
  return { command: process.execPath, args };
}

/**
 * True when running as a single-file executable rather than from a script.
 *
 * `node:sea` exists only inside one, so both the failed import and a false answer
 * mean the same thing. Note the module is not `process.isSEA`, which does not
 * exist — a plausible-looking guess that silently returns undefined forever.
 */
let cachedPackaged: boolean | null = null;

export function isPackaged(): boolean {
  if (cachedPackaged !== null) return cachedPackaged;
  try {
    const require = createRequire(import.meta.url);
    cachedPackaged = Boolean(require('node:sea').isSea());
  } catch {
    cachedPackaged = false;
  }
  return cachedPackaged;
}

function writeMcpConfig(dir: string, surfacePort: number): string {
  const { command, args } = primerEntry();
  const path = join(dir, 'mcp.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: {
          primer: {
            command,
            args,
            // The child must open the same record this process is using, not
            // whatever ~/.primer happens to hold.
            env: {
              PRIMER_HOME: primerHome(),
              PRIMER_DB: dbPath(),
              PRIMER_PORT: String(surfacePort),
            },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  return path;
}

export function buildArgs(opts: ClaudeCodeOptions, mcpConfigPath: string): string[] {
  const args = [
    '-p',
    opts.prompt,
    '--output-format',
    'json',
    '--mcp-config',
    mcpConfigPath,
    // Ignore whatever MCP servers the operator has configured for their own work.
    // A tutoring run should reach this record and nothing else.
    '--strict-mcp-config',
    // No Bash, no Read, no Write, no WebFetch. The tutor cannot touch the
    // filesystem or the network; it can only call the record's own tools.
    '--tools',
    '',
    '--allowedTools',
    AUTONOMOUS_TOOLS.map((t) => `mcp__primer__${t}`).join(','),
    // Replaces the default system prompt outright, so the run does not inherit
    // memory files or the operator's own working instructions.
    '--system-prompt',
    opts.systemPrompt,
    '--no-session-persistence',
    // No hooks, no plugins, no project or user settings. A tutoring run must not
    // pick up whatever the operator has configured for their own work.
    //
    // Note for anyone tempted to reach for `--bare` here: it looks like the right
    // flag and it is not. It forces auth to ANTHROPIC_API_KEY only and never reads
    // the OAuth login, which is the entire thing this transport exists to use.
    '--setting-sources',
    '',
  ];

  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns));
  // Claude Code enforces this itself, which means the ceiling holds even if
  // primer's own accounting is wrong.
  if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) {
    args.push('--max-budget-usd', opts.maxBudgetUsd.toFixed(2));
  }
  return args;
}

export async function runClaudeCode(opts: ClaudeCodeOptions): Promise<ClaudeCodeResult> {
  const empty = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  const dir = join(primerHome(), 'runs', `cc_${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  // Same port the operator's surface uses. If it is already bound, the MCP
  // server reuses it, so generated URLs point where a parent can actually click.
  const configPath = writeMcpConfig(dir, opts.surfacePort ?? Number(process.env.PRIMER_PORT ?? 7333));

  try {
    const { code, stdout, stderr, timedOut } = await exec(
      claudeBinary(),
      buildArgs(opts, configPath),
      opts.timeoutMs ?? 15 * 60_000,
      opts.signal,
    );

    if (timedOut) {
      return { ok: false, text: 'The run exceeded its time limit and was stopped.', cost_usd: 0, turns: 0, usage: empty, failure: 'timeout', denials: [] };
    }

    if (/ENOENT|not recognized|command not found/i.test(stderr) && !stdout.trim()) {
      return {
        ok: false,
        text:
          `Could not run "${claudeBinary()}". Install Claude Code, or point PRIMER_CLAUDE_BIN at it.`,
        cost_usd: 0,
        turns: 0,
        usage: empty,
        failure: 'not_installed',
        denials: [],
      };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return {
        ok: false,
        text: `Claude Code returned output that was not JSON (exit ${code}). ${stderr.slice(0, 400)}`.trim(),
        cost_usd: 0,
        turns: 0,
        usage: empty,
        failure: 'bad_output',
        denials: [],
      };
    }

    const text = String(parsed.result ?? '').trim();
    const usage = {
      input_tokens: parsed.usage?.input_tokens ?? 0,
      output_tokens: parsed.usage?.output_tokens ?? 0,
      cache_read_tokens: parsed.usage?.cache_read_input_tokens ?? 0,
      cache_write_tokens: parsed.usage?.cache_creation_input_tokens ?? 0,
    };
    const base = {
      cost_usd: Number(parsed.total_cost_usd ?? 0),
      turns: Number(parsed.num_turns ?? 0),
      usage,
      denials: parsed.permission_denials ?? [],
      raw: parsed,
    };

    // The one failure an operator will actually hit, so name it plainly rather
    // than surfacing it as a generic error.
    if (/not logged in|please run \/login/i.test(text)) {
      return {
        ...base,
        ok: false,
        failure: 'not_logged_in',
        text: 'Claude Code is not logged in. Run `claude` once and sign in, then try again.',
      };
    }

    if (parsed.is_error) {
      return { ...base, ok: false, failure: 'error', text: text || `Claude Code reported an error (exit ${code}).` };
    }

    return { ...base, ok: true, text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function exec(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  mkdirSync(primerHome(), { recursive: true });
  return new Promise((resolve) => {
    // stdin is ignored on purpose: Claude Code waits on it otherwise, and an
    // unattended run has nothing to type.
    const child = spawn(command, args, {
      shell: command.endsWith('.cmd') || command.endsWith('.bat'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Run from the record's own directory rather than whatever the operator
      // happened to be standing in, so nothing nearby is discoverable.
      cwd: primerHome(),
      signal,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      stderr += String(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
