import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-svc-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb } = await import('../src/db/index.ts');
const { macPlist, windowsTaskXml, systemdUnit, launchCommand, serviceStatus } = await import(
  '../src/agent/service.ts'
);

before(() => db());
after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('the macOS agent can find Claude Code', () => {
  // launchd hands an agent /usr/bin:/bin:/usr/sbin:/sbin and nothing else. The
  // Claude Code installer puts the binary in ~/.local/bin, which is not on that
  // list — so without an explicit PATH the tutor cannot run at all, and the only
  // symptom is runs that fail with "could not run claude".
  const plist = macPlist({});
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, /\.local[/\\]bin/, 'the Claude Code install location must be on PATH');
  assert.match(plist, /\/opt\/homebrew\/bin/);
});

test('the macOS agent restarts if it dies, and is throttled if it dies repeatedly', () => {
  const plist = macPlist({});
  // RunAtLoad only fires once at login; KeepAlive is what survives a crash.
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
});

test('the macOS agent uses absolute paths only', () => {
  const plist = macPlist({});
  // Comments may mention ~/.local/bin while explaining why PATH is set; what must
  // never contain a tilde is a value launchd actually reads, because it expands
  // neither ~ nor $HOME nor globs and simply fails to start.
  const values = [...plist.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<string>([^<]*)<\/string>/g)].map(
    (m) => m[1]!,
  );
  assert.ok(values.length > 3, 'sanity: the plist has values');

  for (const value of values) {
    assert.ok(!value.includes('~'), `"${value}" contains a tilde launchd will not expand`);
    assert.ok(!value.includes('$'), `"${value}" contains a variable launchd will not expand`);
  }

  // Every part of the command that names a file must be absolute. Flags and
  // subcommands are not paths; anything with a separator in it is.
  const argv = launchCommand({});
  for (const piece of argv) {
    if (piece.startsWith('--') || !/[/\\]/.test(piece)) continue;
    assert.ok(
      piece.startsWith('/') || /^[A-Za-z]:/.test(piece),
      `"${piece}" must be an absolute path`,
    );
  }
  assert.ok(
    argv[0]!.startsWith('/') || /^[A-Za-z]:/.test(argv[0]!),
    'the program itself must be absolute',
  );
});

test('the Windows task survives a laptop running on battery', () => {
  // Both of these default to true. On a family laptop that means primer never
  // starts unless it is plugged in, and is killed the moment it is unplugged.
  const xml = windowsTaskXml({});
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
});

test('the Windows task is not killed after three days', () => {
  // The inherited default execution limit would stop a long-running daemon.
  assert.match(windowsTaskXml({}), /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
});

test('the Windows task needs no password and no administrator', () => {
  const xml = windowsTaskXml({});
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/, 'a password prompt would block setup');
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/, 'elevation would need an admin');
});

test('a watchdog trigger restarts it without piling up duplicates', () => {
  const xml = windowsTaskXml({});
  assert.match(xml, /<Interval>PT5M<\/Interval>/, 'periodic check that it is alive');
  assert.match(
    xml,
    /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/,
    'the watchdog must be a no-op while primer is already running',
  );
});

test('the options asked for reach the command line', () => {
  const xml = windowsTaskXml({ lan: true, port: 8080, everyMinutes: 15 });
  const args = xml.match(/<Arguments>([^<]*)<\/Arguments>/)![1]!;
  assert.match(args, /start/);
  assert.match(args, /--watch/);
  assert.match(args, /--lan/);
  assert.match(args, /--port 8080/);
  assert.match(args, /--every 15/);

  const plist = macPlist({ lan: true, port: 8080 });
  assert.match(plist, /<string>--lan<\/string>/);
  assert.match(plist, /<string>8080<\/string>/);
});

test('both descriptions are well-formed enough to be parsed', () => {
  for (const raw of [macPlist({}), windowsTaskXml({})]) {
    assert.match(raw, /^<\?xml version="1\.0"/);

    // Strip the declaration, doctype and comments, then walk the tags keeping a
    // stack. A mismatch here is a file the OS will reject with a famously
    // unhelpful error, so it is worth catching in a test rather than at install.
    const body = raw
      .replace(/<\?[\s\S]*?\?>/g, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    const stack: string[] = [];
    for (const [, closing, name, selfClose] of body.matchAll(
      /<(\/?)([a-zA-Z][\w:.-]*)[^>]*?(\/?)>/g,
    )) {
      if (selfClose) continue;
      if (closing) {
        assert.equal(stack.pop(), name, `</${name}> closes the wrong element`);
      } else {
        stack.push(name!);
      }
    }
    assert.deepEqual(stack, [], 'every element is closed');
  }
});

test('the Linux unit can find Claude Code and survives a restart', () => {
  // Same trap as launchd: a systemd user unit gets a minimal PATH, and the Claude
  // Code binary lives in ~/.local/bin.
  const unit = systemdUnit({});
  assert.match(unit, /Environment=PATH=.*\.local[/\\]bin/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default\.target/, 'without this it never starts at login');
  assert.match(unit, /ExecStart=\S/);
  assert.match(unit, /PRIMER_DB=/, 'the unit must open the record it was installed for');
});

test('a path with a space in it does not split into two arguments', () => {
  // systemd splits ExecStart on whitespace unless quoted, and "C:\Users\Ada Smith"
  // or /home/ada/My Files is entirely ordinary on a family machine.
  const unit = systemdUnit({});
  const exec = /ExecStart=(.*)/.exec(unit)?.[1] ?? '';
  for (const piece of launchCommand({})) {
    if (/\s/.test(piece)) {
      assert.ok(exec.includes(`"${piece}"`), `${piece} contains a space and was not quoted`);
    }
  }
});

test('every service descriptor names a command that can actually run', () => {
  // Running from source the command is `node <script> start --watch`; installed as
  // a binary it is `primer start --watch` with no script at all. Getting this wrong
  // registers a service that fails at every login, and nothing is watching at 3am.
  const argv = launchCommand({ port: 7333, lan: true, everyMinutes: 20 });
  assert.ok(argv.length >= 2);
  assert.deepEqual(argv.slice(-7), ['start', '--watch', '--lan', '--port', '7333', '--every', '20']);

  // An empty entry means a missing script path, which execs as garbage.
  for (const piece of argv) assert.notEqual(piece, '', 'an empty argv entry breaks the exec');

  // Windows and macOS both build their command line from this one function, so a
  // fix in one is a fix in all three.
  assert.ok(windowsTaskXml({}).includes('start --watch'));
  assert.ok(macPlist({}).includes('<string>start</string>'));
});

test('status reports honestly when nothing is installed', () => {
  const status = serviceStatus();
  assert.equal(typeof status.installed, 'boolean');
  assert.ok(status.detail.length > 0, 'always say something a person can act on');
});
