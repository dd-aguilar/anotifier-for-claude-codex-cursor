// src/platforms/macos-focus.mjs — click-to-focus for the macOS toast.
//
// osascript's `display notification` belongs to Script Editor, so a click opens
// Script Editor. terminal-notifier posts the banner as itself and takes a click
// action: `-activate <bundle id>` raises an app, `-execute <command>` runs a
// shell command. This module finds terminal-notifier and builds that action from
// the hook's environment, degrading tab → app → nothing and never throwing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MAC_BUNDLES_BY_TERM_PROGRAM } from '../focus.mjs';

export const TERMINAL_NOTIFIER_BIN = 'terminal-notifier';
export const TERMINAL_NOTIFIER_BUNDLE = 'fr.julienxx.oss.terminal-notifier';
export const TERMINAL_NOTIFIER_INSTALL_HINT = 'brew install terminal-notifier';

const HOMEBREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
const APPLE_TERMINAL = MAC_BUNDLES_BY_TERM_PROGRAM.Apple_Terminal[0];
const SSH_ENV = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'];
const MULTIPLEXER_ENV = ['TMUX', 'STY', 'ZELLIJ'];

// The tty ends up inside a shell command (focusCommand), so anything that is not
// a plain macOS pseudo-terminal path is refused rather than escaped.
const TTY_PATTERN = /^\/dev\/ttys\d{3,}$/;

// Absolute path of terminal-notifier, or null. Homebrew's directories are tried
// after PATH for a hook started with a minimal PATH.
export function findTerminalNotifier({ env = process.env, access = fs.accessSync } = {}) {
  const dirs = [...String(env.PATH || '').split(':'), ...HOMEBREW_BIN_DIRS].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, TERMINAL_NOTIFIER_BIN);
    try {
      access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

// Bundle id of the app that owns the agent's shell, or null. Over ssh the
// agent's machine is not the one the user is looking at.
export function terminalBundleId(env = process.env) {
  if (SSH_ENV.some((k) => env[k])) return null;
  return String(env.__CFBundleIdentifier || '').trim()
    || MAC_BUNDLES_BY_TERM_PROGRAM[env.TERM_PROGRAM]?.[0]
    || null;
}

// The hook's controlling tty (/dev/ttysNNN), or null: `ps` prints `??` for a
// hook started from an IDE panel, and under a multiplexer the terminal's tab
// holds the client's tty, not the pane's.
export function controllingTty({ env = process.env, pid = process.pid, run = execFileSync } = {}) {
  if (MULTIPLEXER_ENV.some((k) => env[k])) return null;
  try {
    const out = String(run('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })).trim();
    const tty = out.startsWith('/dev/') ? out : `/dev/${out}`;
    return TTY_PATTERN.test(tty) ? tty : null;
  } catch {
    return null;
  }
}

// Selects the Apple Terminal tab owning `tty` and raises its window; a closed
// tab falls through to a plain activate.
function appleTerminalTabScript(tty) {
  return [
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
  ].join('\n');
}

// The shell command terminal-notifier runs on click, or null. Only Apple
// Terminal exposes its tabs' ttys to AppleScript today. The script holds no user
// input (the tty matched TTY_PATTERN), so single-quoting it for /bin/sh is safe.
export function focusCommand(bundleId, tty) {
  if (bundleId !== APPLE_TERMINAL || !TTY_PATTERN.test(String(tty || ''))) return null;
  return `osascript -e '${appleTerminalTabScript(tty)}'`;
}

// terminal-notifier arguments for the click: select the tab, else raise the
// app, else nothing (the click then only dismisses the banner).
export function focusArgs({ env = process.env, ttyOf = controllingTty } = {}) {
  const bundleId = terminalBundleId(env);
  if (!bundleId) return [];
  const command = bundleId === APPLE_TERMINAL ? focusCommand(bundleId, ttyOf({ env })) : null;
  return command ? ['-execute', command] : ['-activate', bundleId];
}

// One line for status/doctor: what a click will do on this machine.
export function focusTargetLabel({ env = process.env } = {}) {
  const bundleId = terminalBundleId(env);
  if (!bundleId) return 'click dismisses only (no terminal app in the environment)';
  return bundleId === APPLE_TERMINAL ? `click selects the agent's tab in ${bundleId}` : `click brings ${bundleId} to the front`;
}

// terminal-notifier's "authorization" line from `-diagnose` → doctor state.
// com.apple.ncprefs.plist never lists terminal-notifier, so it has to report on
// itself. Anything not listed here (not requested yet, unreadable, a failed
// run, not installed) is 'unknown'.
const AUTH_BY_DIAGNOSE = {
  authorized: ['authorized', `${TERMINAL_NOTIFIER_BUNDLE} is authorized to post notifications`],
  denied: ['unauthorized', `${TERMINAL_NOTIFIER_BUNDLE} is NOT authorized — banners are dropped; allow terminal-notifier in System Settings → Notifications`],
};

export function terminalNotifierAuthState({ notifier = findTerminalNotifier(), run = execFileSync } = {}) {
  const line = notifier ? diagnoseAuthorization(notifier, run) : 'not installed';
  const [state, detail] = AUTH_BY_DIAGNOSE[line]
    || ['unknown', `${TERMINAL_NOTIFIER_BUNDLE} authorization ${line} — send one toast to be asked`];
  return { state, app: TERMINAL_NOTIFIER_BUNDLE, detail };
}

function diagnoseAuthorization(notifier, run) {
  try {
    const out = String(run(notifier, ['-diagnose'], { encoding: 'utf8', timeout: 5000 }));
    return /^\s*authorization\s+(.+?)\s*$/m.exec(out)?.[1] || 'unreadable';
  } catch {
    return '-diagnose failed';
  }
}
