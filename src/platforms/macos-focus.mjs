// src/platforms/macos-focus.mjs — click-to-focus for the macOS toast.
//
// `osascript -e 'display notification …'` has no app identity of its own, so
// Notification Center credits the banner to Script Editor and a click opens
// Script Editor. terminal-notifier (brew install terminal-notifier) posts the
// same banner as itself and takes a click action: `-activate <bundle id>`
// brings an app to the front, `-execute <command>` runs a shell command. This
// module answers two questions for src/platforms/macos.mjs: is terminal-notifier
// installed, and which click action names the window that ran the agent.
//
// The window is found from the hook's own environment, the way src/focus.mjs
// does it: __CFBundleIdentifier names the app that owns the shell (Terminal,
// iTerm2, a JetBrains IDE, VS Code…), TERM_PROGRAM is the fallback. That is
// enough to raise the app. To select the exact tab, the hook's controlling tty
// is matched against the terminal's own tab list through its scripting
// dictionary; only Apple Terminal is covered today. Every answer degrades to
// the next-best one (tab → app → nothing), and nothing here throws.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TERMINAL_NOTIFIER_BIN = 'terminal-notifier';
export const TERMINAL_NOTIFIER_BUNDLE = 'fr.julienxx.oss.terminal-notifier';
export const TERMINAL_NOTIFIER_INSTALL_HINT = 'brew install terminal-notifier';

// Homebrew's bin directories (Apple silicon, then Intel). The hook inherits the
// user's PATH in the common case, but a hook started with a minimal PATH would
// otherwise miss a perfectly good install.
const HOMEBREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

// TERM_PROGRAM -> bundle id, in the exact case the app declares it (the id is
// handed to terminal-notifier -activate verbatim). Only used when the shell's
// __CFBundleIdentifier is not set.
export const MAC_BUNDLE_BY_TERM_PROGRAM = {
  Apple_Terminal: 'com.apple.Terminal',
  'iTerm.app': 'com.googlecode.iterm2',
  WarpTerminal: 'dev.warp.Warp-Stable',
  ghostty: 'com.mitchellh.ghostty',
  WezTerm: 'com.github.wez.wezterm',
  Hyper: 'co.zeit.hyper',
  alacritty: 'org.alacritty',
  kitty: 'net.kovidgoyal.kitty',
  vscode: 'com.microsoft.VSCode',
};

const SSH_ENV = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'];
const MULTIPLEXER_ENV = ['TMUX', 'STY', 'ZELLIJ'];

// macOS pseudo-terminals are /dev/ttys000, /dev/ttys001, … The tty is embedded
// in a shell command (see focusCommand), so anything else is refused outright
// rather than escaped.
const TTY_PATTERN = /^\/dev\/ttys\d{3,}$/;

// Absolute path of terminal-notifier, or null when it is not installed.
export function findTerminalNotifier({ env = process.env, access = fs.accessSync } = {}) {
  const dirs = [...String(env.PATH || '').split(':'), ...HOMEBREW_BIN_DIRS].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, TERMINAL_NOTIFIER_BIN);
    try {
      access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here, try the next directory
    }
  }
  return null;
}

// Bundle id of the app that owns the agent's shell, or null when unknown. Over
// ssh the agent's machine is not the one the user is looking at, so null.
export function terminalBundleId(env = process.env) {
  if (SSH_ENV.some((k) => env[k])) return null;
  const own = String(env.__CFBundleIdentifier || '').trim();
  if (own) return own;
  return MAC_BUNDLE_BY_TERM_PROGRAM[env.TERM_PROGRAM] || null;
}

// The hook's controlling tty (/dev/ttysNNN), or null. A hook started from an
// IDE panel has none (`ps` prints `??`). Under a multiplexer the terminal's tab
// holds the multiplexer client's tty, not the pane's, so the answer is null and
// the click raises the app instead of selecting a wrong tab.
export function controllingTty({ env = process.env, pid = process.pid, run = execFileSync } = {}) {
  if (MULTIPLEXER_ENV.some((k) => env[k])) return null;
  try {
    const out = String(run('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })).trim();
    if (!out || out === '??') return null;
    const tty = out.startsWith('/dev/') ? out : `/dev/${out}`;
    return TTY_PATTERN.test(tty) ? tty : null;
  } catch {
    return null;
  }
}

// Per-app AppleScript that selects the tab owning `tty` and raises its window,
// falling back to a plain activate when the tab is gone. Apps missing here get
// `-activate` only.
const TAB_SCRIPTS = {
  'com.apple.Terminal': (tty) => [
    'tell application "Terminal"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    `      if tty of t is "${tty}" then`,
    '        set selected tab of w to t',
    '        set frontmost of w to true',
    '        activate',
    '        return',
    '      end if',
    '    end repeat',
    '  end repeat',
    '  activate',
    'end tell',
  ].join('\n'),
};

export const TAB_FOCUS_BUNDLES = Object.keys(TAB_SCRIPTS);

// The shell command terminal-notifier runs on click, or null when the app has no
// tab script or the tty is unusable. The script holds no user input: the bundle
// id is a TAB_SCRIPTS key and the tty matched TTY_PATTERN, neither contains a
// quote, so single-quoting it for /bin/sh is safe as is.
export function focusCommand(bundleId, tty) {
  const script = TAB_SCRIPTS[bundleId];
  if (!script || !TTY_PATTERN.test(String(tty || ''))) return null;
  return `osascript -e '${script(tty)}'`;
}

// terminal-notifier arguments for the click: ['-execute', cmd] to select the
// tab, ['-activate', id] to raise the app, [] when the window is unknown (the
// click then just dismisses the banner, which still beats opening Script Editor).
export function focusArgs({ env = process.env, tty } = {}) {
  const bundleId = terminalBundleId(env);
  if (!bundleId) return [];
  const resolvedTty = tty === undefined && TAB_SCRIPTS[bundleId] ? controllingTty({ env }) : tty;
  const command = focusCommand(bundleId, resolvedTty);
  return command ? ['-execute', command] : ['-activate', bundleId];
}

// terminal-notifier's own authorization state, from `terminal-notifier
// -diagnose` (its "authorization" line: authorized, denied, not requested yet).
// com.apple.ncprefs.plist does not list terminal-notifier, so the plist read in
// macos-delivery.mjs cannot answer for this backend. Returns
// { state: 'authorized' | 'unauthorized' | 'unknown', app, detail }.
export function terminalNotifierAuthState({ notifier = findTerminalNotifier(), run = execFileSync } = {}) {
  const app = TERMINAL_NOTIFIER_BUNDLE;
  if (!notifier) return { state: 'unknown', app, detail: 'terminal-notifier not installed' };
  let line;
  try {
    const out = String(run(notifier, ['-diagnose'], { encoding: 'utf8', timeout: 5000 }));
    line = /^\s*authorization\s+(.+?)\s*$/m.exec(out)?.[1];
  } catch {
    return { state: 'unknown', app, detail: 'terminal-notifier -diagnose failed' };
  }
  if (line === 'authorized') return { state: 'authorized', app, detail: `${app} is authorized to post notifications` };
  if (line === 'denied') {
    return { state: 'unauthorized', app, detail: `${app} is NOT authorized — banners are dropped; allow terminal-notifier in System Settings → Notifications` };
  }
  return { state: 'unknown', app, detail: `${app} authorization ${line || 'unreadable'} — send one toast to be asked` };
}

// One line for status/doctor: what a click will do on this machine.
export function focusTargetLabel({ env = process.env } = {}) {
  const bundleId = terminalBundleId(env);
  if (!bundleId) return 'click dismisses only (no terminal app in the environment)';
  return TAB_SCRIPTS[bundleId] ? `click selects the agent's tab in ${bundleId}` : `click brings ${bundleId} to the front`;
}
