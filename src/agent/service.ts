import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { primerHome, dbPath, logEvent } from '../db/index.ts';
import { isPackaged } from './claude-code.ts';

/**
 * Make primer survive a reboot.
 *
 * Without this the whole premise fails quietly: "it plans on its own overnight"
 * is only true while a terminal window stays open, and no family leaves a terminal
 * window open. The tutor stops the first time the laptop sleeps and nobody is told.
 *
 * Neither platform needs administrator rights — a per-user logon task on Windows
 * and a LaunchAgent on macOS are both things an ordinary account may install for
 * itself. Anything needing admin (a real Windows service, /Library/LaunchDaemons)
 * is out of scope on purpose.
 */

export const SERVICE_LABEL = 'com.primerbrain.agent';
export const TASK_NAME = 'Primer';

export interface ServiceOptions {
  port?: number;
  lan?: boolean;
  everyMinutes?: number;
}

function entryPoint(): string {
  return process.env.PRIMER_ENTRY ?? process.argv[1] ?? '';
}

function serviceArgs(opts: ServiceOptions): string[] {
  const args = ['start', '--watch'];
  if (opts.lan) args.push('--lan');
  if (opts.port) args.push('--port', String(opts.port));
  if (opts.everyMinutes) args.push('--every', String(opts.everyMinutes));
  return args;
}

/**
 * The full command a service manager should run, as argv.
 *
 * Installed as a standalone binary there is no script to name: the executable *is*
 * primer. Passing its own path as the first argument would register a service that
 * tries to run a command named after itself and dies at every login — the exact
 * failure this module exists to prevent, and an invisible one, because nothing is
 * watching at 3am.
 */
export function launchCommand(opts: ServiceOptions): string[] {
  if (isPackaged()) return [process.execPath, ...serviceArgs(opts)];
  const entry = entryPoint();
  const flags = entry.endsWith('.ts') ? ['--experimental-strip-types'] : [];
  return [process.execPath, ...flags, entry, ...serviceArgs(opts)];
}

export function logDir(): string {
  const dir =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Logs', 'primer')
      : join(primerHome(), 'logs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ macOS -- */

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function macPlist(opts: ServiceOptions): string {
  const args = launchCommand(opts);
  const logs = logDir();
  // launchd expands neither ~ nor $HOME nor globs, so everything here is absolute.
  const argXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(primerHome())}</string>
  <!-- A LaunchAgent inherits /usr/bin:/bin:/usr/sbin:/sbin and nothing else, so
       without this the Claude Code binary in ~/.local/bin is simply not found. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(join(homedir(), '.local', 'bin'))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${escapeXml(homedir())}</string>
    <key>PRIMER_HOME</key><string>${escapeXml(primerHome())}</string>
    <key>PRIMER_DB</key><string>${escapeXml(dbPath())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- RunAtLoad only fires once at login; KeepAlive is what restarts a crash. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${escapeXml(join(logs, 'primer.out.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(logs, 'primer.err.log'))}</string>
</dict>
</plist>
`;
}

/* ---------------------------------------------------------------- Windows -- */

export function windowsTaskXml(opts: ServiceOptions): string {
  const [command, ...rest] = launchCommand(opts);
  const args = rest.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
  const user = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Runs primer so it can prepare activities between sessions.</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(user)}</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <!-- Both of these default to true, which on a family laptop means primer never
         starts unless it is plugged in, and is killed the moment it is unplugged. -->
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <!-- Inherited default is three days, after which Windows would kill the tutor. -->
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <AllowHardTerminate>true</AllowHardTerminate>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(command!)}</Command>
      <Arguments>${escapeXml(args)}</Arguments>
      <WorkingDirectory>${escapeXml(primerHome())}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/* ------------------------------------------------------------------ Linux -- */

function unitPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'systemd', 'user', 'primer.service');
}

export function systemdUnit(opts: ServiceOptions): string {
  const [command, ...args] = launchCommand(opts);
  // systemd splits ExecStart on whitespace unless arguments are quoted, and a home
  // directory with a space in it is ordinary on a family machine.
  const exec = [command!, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const path = `${join(homedir(), '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin`;

  return `[Unit]
Description=primer — prepares learning activities between sessions
Documentation=https://github.com/vedan/primer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=${primerHome()}
# A user unit gets a minimal PATH, so the Claude Code binary in ~/.local/bin is
# not found without this — the same trap as the macOS LaunchAgent.
Environment=PATH=${path}
Environment=PRIMER_HOME=${primerHome()}
Environment=PRIMER_DB=${dbPath()}
Restart=always
RestartSec=30
# Journald already timestamps and rotates; a log file here would do neither.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

/* ----------------------------------------------------------------- install -- */

export interface ServiceResult {
  ok: boolean;
  path?: string;
  messages: string[];
}

export function installService(opts: ServiceOptions = {}): ServiceResult {
  const messages: string[] = [];

  if (process.platform === 'darwin') {
    const path = plistPath();
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(path, macPlist(opts), 'utf8');
    const uid = String(process.getuid?.() ?? '');
    try {
      run('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`]); // ignore if absent
    } catch {
      /* not loaded yet */
    }
    try {
      run('launchctl', ['enable', `gui/${uid}/${SERVICE_LABEL}`]);
      run('launchctl', ['bootstrap', `gui/${uid}`, path]);
      messages.push('primer will now start when you log in, and restart if it crashes.');
      messages.push(
        'macOS will show a "Background Items Added" notice; it also appears in ' +
          'System Settings → General → Login Items. Leave it switched on.',
      );
    } catch (err) {
      messages.push(`Wrote ${path}, but launchctl refused: ${(err as Error).message}`);
      messages.push('It will still start at your next login.');
      return { ok: false, path, messages };
    }
    messages.push(`Logs: ${logDir()}`);
    logEvent('cli', 'install_service', 'launchd');
    return { ok: true, path, messages };
  }

  if (process.platform === 'win32') {
    const path = join(primerHome(), 'primer-task.xml');
    // Task Scheduler rejects UTF-8 here with a misleading "value which is
    // incorrectly formatted" error. It wants UTF-16 LE with a BOM.
    writeFileSync(path, Buffer.from('﻿' + windowsTaskXml(opts), 'utf16le'));
    try {
      run('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', path, '/F']);
      messages.push('primer will now start when you sign in, and be restarted if it stops.');
      messages.push(
        'A console window belongs to it — Node has no windowless build, so minimise ' +
          'it rather than closing it. Closing the window stops primer until next login.',
      );
      messages.push(`Logs: ${logDir()}`);
      logEvent('cli', 'install_service', 'schtasks');
      return { ok: true, path, messages };
    } catch (err) {
      messages.push(`Could not register the task: ${(err as Error).message}`);
      messages.push(`The task description is at ${path} if you want to import it by hand.`);
      return { ok: false, path, messages };
    }
  }

  if (process.platform === 'linux') {
    const path = unitPath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, systemdUnit(opts), 'utf8');
    try {
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', 'primer.service']);
      messages.push('primer will now start when you log in, and restart if it stops.');
      // Without lingering, a user unit is torn down at logout and started again at
      // the next graphical login — so "it plans overnight" is false on a machine
      // nobody is signed into. This needs root, so tell them rather than trying.
      messages.push(
        'To keep it running when you are logged out, run once:  ' +
          `sudo loginctl enable-linger ${process.env.USER ?? '$USER'}`,
      );
      messages.push('Logs: journalctl --user -u primer -f');
      logEvent('cli', 'install_service', 'systemd');
      return { ok: true, path, messages };
    } catch (err) {
      messages.push(`Wrote ${path}, but systemctl refused: ${(err as Error).message}`);
      messages.push('On a system without systemd, run `primer start --watch` from your own supervisor.');
      return { ok: false, path, messages };
    }
  }

  messages.push(`Automatic start is not set up for ${process.platform} yet.`);
  messages.push('Run `primer start --watch` from a terminal, or use your own service manager.');
  return { ok: false, messages };
}

export function uninstallService(): ServiceResult {
  const messages: string[] = [];
  if (process.platform === 'darwin') {
    const uid = String(process.getuid?.() ?? '');
    try {
      run('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`]);
    } catch {
      /* already gone */
    }
    if (existsSync(plistPath())) rmSync(plistPath(), { force: true });
    messages.push('primer will no longer start on its own.');
    logEvent('cli', 'uninstall_service', 'launchd');
    return { ok: true, messages };
  }
  if (process.platform === 'win32') {
    try {
      run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
      messages.push('primer will no longer start on its own.');
      logEvent('cli', 'uninstall_service', 'schtasks');
      return { ok: true, messages };
    } catch (err) {
      messages.push(`Nothing to remove, or it could not be removed: ${(err as Error).message}`);
      return { ok: false, messages };
    }
  }
  if (process.platform === 'linux') {
    try {
      run('systemctl', ['--user', 'disable', '--now', 'primer.service']);
    } catch {
      /* not loaded */
    }
    if (existsSync(unitPath())) rmSync(unitPath(), { force: true });
    try {
      run('systemctl', ['--user', 'daemon-reload']);
    } catch {
      /* nothing to reload */
    }
    messages.push('primer will no longer start on its own.');
    logEvent('cli', 'uninstall_service', 'systemd');
    return { ok: true, messages };
  }
  messages.push('Nothing to remove.');
  return { ok: true, messages };
}

export function serviceStatus(): { installed: boolean; detail: string } {
  if (process.platform === 'darwin') {
    const uid = String(process.getuid?.() ?? '');
    try {
      const out = run('launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`]);
      const state = out.match(/state = (\w+)/)?.[1] ?? 'unknown';
      return { installed: true, detail: `registered with launchd, state ${state}` };
    } catch {
      return {
        installed: existsSync(plistPath()),
        detail: existsSync(plistPath())
          ? 'the plist exists but launchd has not loaded it — log out and back in'
          : 'not installed',
      };
    }
  }
  if (process.platform === 'win32') {
    try {
      const out = run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST']);
      const status = out.match(/Status:\s*(.+)/)?.[1]?.trim() ?? 'unknown';
      return { installed: true, detail: `registered as a logon task, status ${status}` };
    } catch {
      return { installed: false, detail: 'not installed' };
    }
  }
  if (process.platform === 'linux') {
    try {
      const state = run('systemctl', ['--user', 'is-active', 'primer.service']).trim();
      const lingering = (() => {
        try {
          return /Linger=yes/.test(run('loginctl', ['show-user', process.env.USER ?? '']));
        } catch {
          return false;
        }
      })();
      return {
        installed: true,
        detail: `registered as a systemd user unit, ${state}${
          lingering ? '' : ' (stops at logout — see `loginctl enable-linger`)'
        }`,
      };
    } catch {
      return {
        installed: existsSync(unitPath()),
        detail: existsSync(unitPath())
          ? 'the unit exists but systemd has not enabled it — run `systemctl --user enable --now primer`'
          : 'not installed',
      };
    }
  }
  return { installed: false, detail: `not supported on ${process.platform}` };
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
}
