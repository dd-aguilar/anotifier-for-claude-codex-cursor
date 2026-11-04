// tests/macos-focus.test.mjs — click-to-focus on macOS: the terminal-notifier
// lookup, the window the click should raise, and which backend sendToast picks.
// Everything is injected (no real ps, osascript or terminal-notifier runs), so
// the suite is the same on every OS.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTerminalNotifier,
  terminalBundleId,
  controllingTty,
  focusCommand,
  focusArgs,
  focusTargetLabel,
  terminalNotifierAuthState,
  TERMINAL_NOTIFIER_BUNDLE,
  TAB_FOCUS_BUNDLES,
} from '../src/platforms/macos-focus.mjs';
import { sendToast, osascriptArgs, terminalNotifierArgs, optionValue } from '../src/platforms/macos.mjs';
import { notificationAuthState } from '../src/platforms/macos-delivery.mjs';
import { toastDisplay, clickToFocusLabel, PLATFORM_DISPLAY } from '../cli/status.mjs';
import { useFakeHome } from './fake-home.mjs';
useFakeHome();

const TERMINAL = 'com.apple.Terminal';
const NOTIFIER = '/opt/homebrew/bin/terminal-notifier';

// An execFile stand-in for the toast process: records the call, succeeds.
function fakeExecFile() {
  const calls = [];
  const execFileImpl = (command, args, options, cb) => { calls.push({ command, args }); cb(null, '', ''); };
  return { execFileImpl, calls };
}

// fs.accessSync stand-in: only the listed paths exist.
const accessOnly = (...paths) => (p) => { if (!paths.includes(p)) throw new Error('ENOENT'); };

describe('findTerminalNotifier', () => {
  it('walks PATH first, then the Homebrew bin directories', () => {
    assert.equal(findTerminalNotifier({ env: { PATH: '/usr/bin:/my/bin' }, access: accessOnly('/my/bin/terminal-notifier') }), '/my/bin/terminal-notifier');
    assert.equal(findTerminalNotifier({ env: { PATH: '/usr/bin' }, access: accessOnly(NOTIFIER) }), NOTIFIER);
    assert.equal(findTerminalNotifier({ env: { PATH: '' }, access: accessOnly('/usr/local/bin/terminal-notifier') }), '/usr/local/bin/terminal-notifier');
  });

  it('null when it is installed nowhere', () => {
    assert.equal(findTerminalNotifier({ env: { PATH: '/usr/bin:/bin' }, access: accessOnly() }), null);
    assert.equal(findTerminalNotifier({ env: {}, access: accessOnly() }), null);
  });
});

describe('terminalBundleId — the app that owns the agent\'s shell', () => {
  it('__CFBundleIdentifier wins, verbatim', () => {
    assert.equal(terminalBundleId({ __CFBundleIdentifier: 'com.jetbrains.pycharm', TERM_PROGRAM: 'Apple_Terminal' }), 'com.jetbrains.pycharm');
    assert.equal(terminalBundleId({ __CFBundleIdentifier: '  com.apple.Terminal ' }), TERMINAL);
  });

  it('falls back to a known TERM_PROGRAM', () => {
    assert.equal(terminalBundleId({ TERM_PROGRAM: 'Apple_Terminal' }), TERMINAL);
    assert.equal(terminalBundleId({ TERM_PROGRAM: 'iTerm.app' }), 'com.googlecode.iterm2');
    assert.equal(terminalBundleId({ TERM_PROGRAM: 'vscode' }), 'com.microsoft.VSCode');
  });

  it('null for an unknown TERM_PROGRAM, an empty env, or an ssh session', () => {
    assert.equal(terminalBundleId({ TERM_PROGRAM: 'Zed' }), null);
    assert.equal(terminalBundleId({}), null);
    assert.equal(terminalBundleId({ __CFBundleIdentifier: TERMINAL, SSH_CONNECTION: '1 2 3 4' }), null);
    assert.equal(terminalBundleId({ __CFBundleIdentifier: TERMINAL, SSH_TTY: '/dev/ttys001' }), null);
  });
});

describe('controllingTty — the hook\'s own tty from ps', () => {
  const ps = (out) => (file, args) => {
    assert.equal(file, 'ps');
    assert.deepEqual(args, ['-o', 'tty=', '-p', '4242']);
    return out;
  };

  it('prefixes /dev/ and accepts only a pseudo-terminal path', () => {
    assert.equal(controllingTty({ env: {}, pid: 4242, run: ps('ttys003\n') }), '/dev/ttys003');
    assert.equal(controllingTty({ env: {}, pid: 4242, run: ps('/dev/ttys012') }), '/dev/ttys012');
  });

  it('null for no tty (an IDE panel), garbage, an empty answer or a failing ps', () => {
    assert.equal(controllingTty({ env: {}, pid: 4242, run: ps('??') }), null);
    assert.equal(controllingTty({ env: {}, pid: 4242, run: ps('') }), null);
    assert.equal(controllingTty({ env: {}, pid: 4242, run: ps('console') }), null);
    assert.equal(controllingTty({ env: {}, pid: 4242, run: ps("ttys003'; rm -rf x") }), null);
    assert.equal(controllingTty({ env: {}, pid: 4242, run: () => { throw new Error('boom'); } }), null);
  });

  it('null under a multiplexer: the terminal tab holds the client\'s tty, not ours', () => {
    let ran = false;
    const run = () => { ran = true; return 'ttys003'; };
    for (const env of [{ TMUX: '/tmp/tmux-1/default,1,0' }, { STY: '1.pts-0' }, { ZELLIJ: '0' }]) {
      assert.equal(controllingTty({ env, pid: 4242, run }), null);
    }
    assert.equal(ran, false);
  });
});

describe('focusCommand — the shell command terminal-notifier runs on click', () => {
  it('Apple Terminal: select the tab owning the tty, raise its window, else just activate', () => {
    const cmd = focusCommand(TERMINAL, '/dev/ttys003');
    assert.ok(cmd.startsWith("osascript -e '"), cmd);
    assert.ok(cmd.endsWith("'"), cmd);
    assert.match(cmd, /tell application "Terminal"/);
    assert.match(cmd, /if tty of t is "\/dev\/ttys003" then/);
    assert.match(cmd, /set selected tab of w to t/);
    assert.match(cmd, /set frontmost of w to true/);
    // The fallback activate for a closed tab, after the loops.
    assert.match(cmd, /end repeat\n {2}activate\nend tell'$/);
    // Nothing in the script can close the single-quoted shell argument.
    assert.equal(cmd.slice("osascript -e '".length, -1).includes("'"), false);
  });

  it('null for an app without a tab script or a tty that is not a pseudo-terminal', () => {
    assert.equal(focusCommand('com.googlecode.iterm2', '/dev/ttys003'), null);
    assert.equal(focusCommand(TERMINAL, null), null);
    assert.equal(focusCommand(TERMINAL, ''), null);
    assert.equal(focusCommand(TERMINAL, '/dev/ttys003"; say hi; "'), null);
    assert.equal(focusCommand(TERMINAL, 'ttys003'), null);
  });

  it('TAB_FOCUS_BUNDLES lists exactly the apps with a tab script', () => {
    assert.deepEqual(TAB_FOCUS_BUNDLES, [TERMINAL]);
  });
});

describe('focusArgs — what the click does, best answer first', () => {
  it('-execute with the tab script when the app has one and the tty is known', () => {
    const args = focusArgs({ env: { __CFBundleIdentifier: TERMINAL }, tty: '/dev/ttys003' });
    assert.equal(args[0], '-execute');
    assert.equal(args[1], focusCommand(TERMINAL, '/dev/ttys003'));
  });

  it('-activate when the tty is unknown (IDE panel, tmux) or the app has no tab script', () => {
    assert.deepEqual(focusArgs({ env: { __CFBundleIdentifier: TERMINAL }, tty: null }), ['-activate', TERMINAL]);
    assert.deepEqual(focusArgs({ env: { __CFBundleIdentifier: 'com.jetbrains.pycharm' }, tty: '/dev/ttys003' }), ['-activate', 'com.jetbrains.pycharm']);
    assert.deepEqual(focusArgs({ env: { TERM_PROGRAM: 'iTerm.app' }, tty: '/dev/ttys003' }), ['-activate', 'com.googlecode.iterm2']);
  });

  it('nothing when no terminal app is known', () => {
    assert.deepEqual(focusArgs({ env: {}, tty: '/dev/ttys003' }), []);
    assert.deepEqual(focusArgs({ env: { __CFBundleIdentifier: TERMINAL, SSH_CLIENT: 'x' }, tty: '/dev/ttys003' }), []);
  });

  it('does not look the tty up when the app could not use it', () => {
    // tty undefined would trigger controllingTty, which runs ps. For an app
    // without a tab script that lookup is skipped: -activate needs no tty.
    assert.deepEqual(focusArgs({ env: { __CFBundleIdentifier: 'com.jetbrains.pycharm', TMUX: '1' } }), ['-activate', 'com.jetbrains.pycharm']);
  });
});

describe('focusTargetLabel — one line for status and doctor', () => {
  it('names the tab, the app, or the absence of either', () => {
    assert.match(focusTargetLabel({ env: { __CFBundleIdentifier: TERMINAL } }), /selects the agent's tab in com\.apple\.Terminal/);
    assert.match(focusTargetLabel({ env: { __CFBundleIdentifier: 'com.jetbrains.pycharm' } }), /brings com\.jetbrains\.pycharm to the front/);
    assert.match(focusTargetLabel({ env: {} }), /dismisses only/);
  });
});

describe('optionValue — terminal-notifier option values that would misparse', () => {
  it('backslash-prefixes a leading [ ( { quote or dash, leaves the rest alone', () => {
    for (const lead of ['[', '(', '{', '"', "'", '-']) {
      assert.equal(optionValue(`${lead}rest`), `\\${lead}rest`);
    }
    assert.equal(optionValue('plain [x]'), 'plain [x]');
    assert.equal(optionValue(''), '');
    assert.equal(optionValue(undefined), '');
  });
});

describe('terminalNotifierArgs / osascriptArgs', () => {
  const note = { title: 'app · Claude Code', message: 'Task complete' };

  it('terminal-notifier: title, message, the sound (default when none), then the click action', () => {
    assert.deepEqual(
      terminalNotifierArgs(note, { sound: 'Glass', focus: ['-activate', TERMINAL] }),
      ['-title', 'app · Claude Code', '-message', 'Task complete', '-sound', 'Glass', '-activate', TERMINAL],
    );
    assert.deepEqual(terminalNotifierArgs(note, { sound: null }), ['-title', 'app · Claude Code', '-message', 'Task complete', '-sound', 'default']);
  });

  it('terminal-notifier: a custom sound file already playing means no sound at all', () => {
    assert.deepEqual(terminalNotifierArgs(note, { sound: null, silent: true }), ['-title', 'app · Claude Code', '-message', 'Task complete']);
  });

  it('terminal-notifier: escapes a title or message that starts with an option-like character', () => {
    const args = terminalNotifierArgs({ title: '[proj] · Claude Code', message: '- Fixed the bug' }, { sound: null });
    assert.equal(args[1], '\\[proj] · Claude Code');
    assert.equal(args[3], '\\- Fixed the bug');
  });

  it('osascript: the display notification script, sound clause only when named and not silent', () => {
    assert.deepEqual(osascriptArgs({ title: 'T', message: 'M' }, { sound: 'Glass' }), ['-e', 'display notification "M" with title "T" sound name "Glass"']);
    assert.deepEqual(osascriptArgs({ title: 'T', message: 'M' }, { sound: null }), ['-e', 'display notification "M" with title "T"']);
    assert.deepEqual(osascriptArgs({ title: 'T', message: 'M' }, { sound: 'Glass', silent: true }), ['-e', 'display notification "M" with title "T"']);
  });
});

describe('sendToast picks the backend', () => {
  const note = { title: 'T', message: 'M', toastSound: 'IM', clickToFocus: true };
  const quiet = { log: () => {} };

  it('terminal-notifier when installed and the toast is click-to-focus', async () => {
    const toast = fakeExecFile();
    const ok = await sendToast(note, { ...quiet, execFileImpl: toast.execFileImpl, notifier: () => NOTIFIER, focus: () => ['-activate', TERMINAL] });
    assert.equal(ok, true);
    assert.equal(toast.calls.length, 1);
    assert.equal(toast.calls[0].command, NOTIFIER);
    assert.deepEqual(toast.calls[0].args, ['-title', 'T', '-message', 'M', '-sound', 'Glass', '-activate', TERMINAL]);
  });

  it('osascript when terminal-notifier is not installed', async () => {
    const toast = fakeExecFile();
    let focusAsked = false;
    await sendToast(note, { ...quiet, execFileImpl: toast.execFileImpl, notifier: () => null, focus: () => { focusAsked = true; return []; } });
    assert.equal(toast.calls[0].command, 'osascript');
    assert.deepEqual(toast.calls[0].args, ['-e', 'display notification "M" with title "T" sound name "Glass"']);
    assert.equal(focusAsked, false, 'no window lookup on the osascript path');
  });

  it('osascript for clickToFocus: false (usage/context alerts), even with terminal-notifier installed', async () => {
    const toast = fakeExecFile();
    let notifierAsked = false;
    await sendToast({ ...note, clickToFocus: false }, { ...quiet, execFileImpl: toast.execFileImpl, notifier: () => { notifierAsked = true; return NOTIFIER; } });
    assert.equal(toast.calls[0].command, 'osascript');
    assert.equal(notifierAsked, false);
  });

  it('a missing clickToFocus field means click-to-focus (the config default)', async () => {
    const toast = fakeExecFile();
    await sendToast({ title: 'T', message: 'M' }, { ...quiet, execFileImpl: toast.execFileImpl, notifier: () => NOTIFIER, focus: () => [] });
    assert.equal(toast.calls[0].command, NOTIFIER);
    assert.deepEqual(toast.calls[0].args, ['-title', 'T', '-message', 'M', '-sound', 'default']);
  });

  it('a failing terminal-notifier resolves false and logs which backend failed', async () => {
    const entries = [];
    const execFileImpl = (command, args, options, cb) => cb(Object.assign(new Error('exit 3'), { code: 3 }), '', 'Notifications are turned off');
    const ok = await sendToast(note, { log: (ctx, err, extra) => entries.push({ ctx, extra }), execFileImpl, notifier: () => NOTIFIER, focus: () => [] });
    assert.equal(ok, false);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].ctx, 'toast:macos');
    assert.equal(entries[0].extra.backend, NOTIFIER);
    assert.match(entries[0].extra.stderr, /turned off/);
  });
});

describe('notificationAuthState({ owner })', () => {
  it('never throws for either owner and keeps the structured shape', () => {
    for (const owner of ['osascript', 'terminal-notifier']) {
      const s = notificationAuthState({ owner });
      assert.ok(['authorized', 'unauthorized', 'unknown'].includes(s.state));
      assert.ok(typeof s.detail === 'string');
    }
  });

  it('exports the terminal-notifier bundle id it looks for', () => {
    assert.equal(TERMINAL_NOTIFIER_BUNDLE, 'fr.julienxx.oss.terminal-notifier');
  });
});

describe('terminalNotifierAuthState — from terminal-notifier -diagnose', () => {
  const diagnose = (line) => (file, args) => {
    assert.equal(file, NOTIFIER);
    assert.deepEqual(args, ['-diagnose']);
    return `terminal-notifier 3.1.0\n  bundle id  ${TERMINAL_NOTIFIER_BUNDLE}\n\n  authorization       ${line}\n  alerts              enabled\n`;
  };

  it('maps authorized / denied / anything else', () => {
    assert.equal(terminalNotifierAuthState({ notifier: NOTIFIER, run: diagnose('authorized') }).state, 'authorized');
    const denied = terminalNotifierAuthState({ notifier: NOTIFIER, run: diagnose('denied') });
    assert.equal(denied.state, 'unauthorized');
    assert.match(denied.detail, /System Settings/);
    const fresh = terminalNotifierAuthState({ notifier: NOTIFIER, run: diagnose('not requested yet') });
    assert.equal(fresh.state, 'unknown');
    assert.match(fresh.detail, /not requested yet/);
  });

  it('unknown when it is not installed or -diagnose fails', () => {
    assert.equal(terminalNotifierAuthState({ notifier: null }).state, 'unknown');
    assert.equal(terminalNotifierAuthState({ notifier: NOTIFIER, run: () => { throw new Error('x'); } }).state, 'unknown');
    assert.equal(terminalNotifierAuthState({ notifier: NOTIFIER, run: () => 'garbage' }).state, 'unknown');
  });
});

describe('status: the macOS toast line', () => {
  it('names terminal-notifier as the backend only on darwin with it installed', () => {
    assert.equal(toastDisplay('darwin', { notifier: () => NOTIFIER }).toast, 'terminal-notifier');
    assert.equal(toastDisplay('darwin', { notifier: () => null }).toast, PLATFORM_DISPLAY.darwin.toast);
    assert.deepEqual(toastDisplay('win32', { notifier: () => NOTIFIER }), PLATFORM_DISPLAY.win32);
    assert.deepEqual(toastDisplay('linux', { notifier: () => NOTIFIER }), PLATFORM_DISPLAY.linux);
  });

  it('says what click-to-focus still needs on darwin', () => {
    assert.equal(clickToFocusLabel('darwin', { notifier: () => NOTIFIER }), 'click-to-focus');
    assert.match(clickToFocusLabel('darwin', { notifier: () => null }), /needs: brew install terminal-notifier/);
    assert.equal(clickToFocusLabel('win32', { notifier: () => null }), 'click-to-focus');
  });
});
