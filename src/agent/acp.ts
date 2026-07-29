/**
 * Drive the tutor over the Agent Client Protocol.
 *
 * Today the unattended path spawns `claude -p … --mcp-config` and waits for one
 * JSON blob. That works, but it is a CLI integration: no streaming, no shared
 * session model with Claude Desktop / Zed / Conductor-style UIs, and nothing a
 * parent-facing shell can subscribe to.
 *
 * ACP is the standard wire for "editor ↔ coding agent". Primer acts as the
 * client: we spawn an ACP agent (claude-code-acp when present), hand it our MCP
 * server as the only tools it may use, auto-allow those tools, and stream the
 * turn. If no ACP agent is installed we fall back to the CLI path — same login,
 * same record, worse UX for the shell.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { primerHome, dbPath } from '../db/index.ts';
import {
  AUTONOMOUS_TOOLS,
  type ClaudeCodeOptions,
  type ClaudeCodeResult,
  isPackaged,
  runClaudeCode,
} from './claude-code.ts';

export type TutorTransport = 'acp' | 'cli';

export interface TutorRunOptions extends ClaudeCodeOptions {
  /** Prefer ACP; fall back to CLI when the agent binary is missing. Default true. */
  preferAcp?: boolean;
  onUpdate?: (update: acp.SessionNotification['update']) => void;
}

function primerMcpLaunch(surfacePort: number): {
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
} {
  const env = [
    { name: 'PRIMER_HOME', value: primerHome() },
    { name: 'PRIMER_DB', value: dbPath() },
    { name: 'PRIMER_PORT', value: String(surfacePort) },
  ];
  if (isPackaged()) {
    return { command: process.execPath, args: ['mcp'], env };
  }
  const entry = process.env.PRIMER_ENTRY ?? process.argv[1] ?? '';
  const args = entry.endsWith('.ts')
    ? ['--experimental-strip-types', entry, 'mcp']
    : [entry, 'mcp'];
  return { command: process.execPath, args, env };
}

/**
 * Locate an ACP agent that speaks Claude (subscription login).
 *
 * Order: explicit override → common install paths → bare name on PATH.
 * Missing is not an error — the caller falls back to the CLI transport.
 */
export function acpAgentBinary(): string | null {
  if (process.env.PRIMER_ACP_AGENT) return process.env.PRIMER_ACP_AGENT;
  if (process.env.PRIMER_NO_ACP === '1') return null;

  const home = homedir();
  const windows = process.platform === 'win32';
  const names = windows
    ? ['claude-code-acp.cmd', 'claude-code-acp.exe', 'claude-agent-acp.cmd', 'claude-agent-acp.exe']
    : ['claude-code-acp', 'claude-agent-acp'];

  const dirs = windows
    ? [
        join(home, 'AppData', 'Roaming', 'npm'),
        join(home, '.local', 'bin'),
        join(process.cwd(), 'node_modules', '.bin'),
      ]
    : [
        join(home, '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        join(home, '.npm-global', 'bin'),
        join(process.cwd(), 'node_modules', '.bin'),
      ];

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function emptyUsage(): ClaudeCodeResult['usage'] {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
}

function isPrimerTool(title: string | undefined, rawInput: unknown): boolean {
  const hay = `${title ?? ''} ${typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput ?? {})}`;
  if (/mcp__primer__|primer_/i.test(hay)) return true;
  return AUTONOMOUS_TOOLS.some((t) => hay.includes(t));
}

/**
 * Auto-allow primer MCP tools; refuse everything else (filesystem, shell, web).
 * An unattended tutoring run must not inherit the agent's full coding powers.
 */
function pickPermission(
  params: acp.RequestPermissionRequest,
): acp.RequestPermissionResponse {
  const allow = isPrimerTool(params.toolCall?.title ?? undefined, params.toolCall?.rawInput);
  const options = params.options ?? [];
  const preferred = allow
    ? options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') ??
      options.find((o) => /allow/i.test(o.name))
    : options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always') ??
      options.find((o) => /reject|deny|cancel/i.test(o.name));

  if (preferred) {
    return { outcome: { outcome: 'selected', optionId: preferred.optionId } };
  }
  // No matching option — cancel the turn rather than guess.
  return { outcome: { outcome: 'cancelled' } };
}

async function runViaAcp(
  agentBin: string,
  opts: TutorRunOptions,
): Promise<ClaudeCodeResult> {
  const empty = emptyUsage();
  const surfacePort = opts.surfacePort ?? Number(process.env.PRIMER_PORT ?? 7333);
  const mcp = primerMcpLaunch(surfacePort);

  let child: ChildProcess | undefined;
  let timedOut = false;
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child?.kill();
        }, opts.timeoutMs)
      : undefined;

  try {
    child = spawn(agentBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: agentBin.endsWith('.cmd') || agentBin.endsWith('.bat'),
      windowsHide: true,
      cwd: primerHome(),
      env: {
        ...process.env,
        // Prefer the Claude Code subscription login over a stray API key.
        // The adapter still works if only an API key is present.
      },
      signal: opts.signal,
    });

    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d));

    const input = Writable.toWeb(child.stdin!);
    const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    let agentText = '';
    let turns = 0;

    const stopReason = await acp
      .client({ name: 'primer' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        Promise.resolve(pickPermission(ctx.params)),
      )
      // Unattended tutor: never write or read arbitrary files through the client.
      .onRequest(acp.methods.client.fs.writeTextFile, async () => ({}))
      .onRequest(acp.methods.client.fs.readTextFile, async () => ({ content: '' }))
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: 'primer', version: '0.1.0' },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
          },
        });

        return ctx
          .buildSession({
            cwd: primerHome(),
            mcpServers: [
              {
                name: 'primer',
                command: mcp.command,
                args: mcp.args,
                env: mcp.env,
              },
            ],
          })
          .withSession(async (session) => {
            // System guidance is folded into the user prompt: ACP has no separate
            // systemPrompt field on session/prompt the way the CLI -p path does.
            const prompt =
              `${opts.systemPrompt}\n\n---\n\n${opts.prompt}\n\n` +
              `You may only use the primer MCP tools. Do not use Bash, Read, Write, ` +
              `or any other built-in. Call learner_context first.`;

            session.prompt(prompt);

            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === 'stop') {
                return message.response;
              }
              turns += 1;
              const update = message.notification.update;
              opts.onUpdate?.(update);
              if (update.sessionUpdate === 'agent_message_chunk') {
                const content = (update as { content?: { type?: string; text?: string } }).content;
                if (content?.type === 'text' && content.text) agentText += content.text;
              }
            }
          });
      });

    if (timedOut) {
      return {
        ok: false,
        text: 'The run exceeded its time limit and was stopped.',
        cost_usd: 0,
        turns,
        usage: empty,
        failure: 'timeout',
        denials: [],
      };
    }

    const stop = String((stopReason as { stopReason?: string })?.stopReason ?? '');
    if (/cancel/i.test(stop)) {
      return {
        ok: false,
        text: agentText || 'The tutoring run was cancelled.',
        cost_usd: 0,
        turns,
        usage: empty,
        failure: 'error',
        denials: [],
      };
    }

    if (/not logged in|please run \/login|authentication/i.test(agentText + stderr)) {
      return {
        ok: false,
        text: 'Claude is not logged in. Open Claude Code once and sign in, then try again.',
        cost_usd: 0,
        turns,
        usage: empty,
        failure: 'not_logged_in',
        denials: [],
      };
    }

    return {
      ok: true,
      text: agentText.trim() || 'Done.',
      cost_usd: 0,
      turns,
      usage: empty,
      denials: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not recognized|command not found/i.test(msg)) {
      return {
        ok: false,
        text: `Could not run ACP agent "${agentBin}".`,
        cost_usd: 0,
        turns: 0,
        usage: empty,
        failure: 'not_installed',
        denials: [],
      };
    }
    return {
      ok: false,
      text: msg,
      cost_usd: 0,
      turns: 0,
      usage: empty,
      failure: 'error',
      denials: [],
    };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      child?.kill();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run one tutoring turn. Prefers ACP when an agent is available; otherwise CLI.
 */
export async function runTutorModel(
  opts: TutorRunOptions,
): Promise<ClaudeCodeResult & { transport: TutorTransport }> {
  const preferAcp = opts.preferAcp !== false;
  const agent = preferAcp ? acpAgentBinary() : null;

  if (agent) {
    const result = await runViaAcp(agent, opts);
    // Soft-fallback: a missing/broken ACP binary should not strand a parent who
    // already has Claude Code working via the CLI.
    if (result.failure === 'not_installed') {
      const cli = await runClaudeCode(opts);
      return { ...cli, transport: 'cli' };
    }
    return { ...result, transport: 'acp' };
  }

  const cli = await runClaudeCode(opts);
  return { ...cli, transport: 'cli' };
}

/** What the parent shell shows about how the tutor will talk to Claude. */
export function transportStatus(): {
  transport: TutorTransport;
  agent: string | null;
  note: string;
} {
  const agent = acpAgentBinary();
  if (agent) {
    return {
      transport: 'acp',
      agent,
      note: 'Talking to Claude through ACP — same login as Claude Code / Desktop.',
    };
  }
  return {
    transport: 'cli',
    agent: null,
    note:
      'Using the Claude Code CLI. Install an ACP agent (e.g. claude-code-acp) for the streaming UI path.',
  };
}
