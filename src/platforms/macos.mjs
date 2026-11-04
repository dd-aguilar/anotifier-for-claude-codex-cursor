// src/platforms/macos.mjs
import { execFile } from 'node:child_process';
import { logHookError } from '../error-log.mjs';
import { execFailureReason, noteFailure } from '../channel-failure.mjs';
import { playFirst, prepareSoundFile } from './sound.mjs';
import { findTerminalNotifier, focusArgs } from './macos-focus.mjs';

// The 14 built-in macOS system sounds (files in /System/Library/Sounds).
const MAC_SYSTEM_SOUNDS = new Set([
  'Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero',
  'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink',
]);

// Default config ships Windows SoundEvent names (IM, Reminder, …). Forwarding
// them to `sound name "IM"` produces an invalid NSSound name that macOS ignores
// (and logs). Map the shipped names to real macOS sounds; omit the clause for
// Default/unknown so the system default sound plays.
const WINDOWS_TO_MAC_SOUND = { IM: 'Glass', Reminder: 'Ping', Mail: 'Purr', SMS: 'Tink' };

// terminal-notifier's name for the system default sound (osascript gets it by
// omitting the sound clause).
const NOTIFIER_DEFAULT_SOUND = 'default';

export function macSoundName(toastSound) {
  if (!toastSound || toastSound === 'Default') return null;
  if (MAC_SYSTEM_SOUNDS.has(toastSound)) return toastSound;
  if (WINDOWS_TO_MAC_SOUND[toastSound]) return WINDOWS_TO_MAC_SOUND[toastSound];
  if (/^(Alarm|Call)\d*$/.test(toastSound)) return 'Sosumi';
  return null;
}

// The osascript backend: `display notification`. Always available, but the
// banner belongs to Script Editor, so a click opens Script Editor.
export function osascriptArgs(notification, { sound, silent = false } = {}) {
  const soundClause = !silent && sound ? ` sound name "${esc(sound)}"` : '';
  return ['-e', `display notification "${esc(notification.message)}" with title "${esc(notification.title)}"${soundClause}`];
}

// The terminal-notifier backend, used when it is installed and the toast is
// click-to-focus (usage/context alerts opt out: there is no window to focus).
// `focus` is what focusArgs() found: the click selects the agent's tab, raises
// its app, or does nothing. `silent` keeps a custom sound file (already playing
// through afplay) from doubling with the default sound.
export function terminalNotifierArgs(notification, { sound, silent = false, focus = [] } = {}) {
  const args = ['-title', optionValue(notification.title), '-message', optionValue(notification.message)];
  if (!silent) args.push('-sound', sound || NOTIFIER_DEFAULT_SOUND);
  return args.concat(focus);
}

// terminal-notifier reads its options through NSUserDefaults, which parses a
// value that starts with `[`, `(`, `{`, a quote or `-` as something else (a
// plist, another option) and exits 2. Its own help says to escape such a value
// with a backslash, and the backslash is not shown (verified with 3.1.0).
const NEEDS_ESCAPE = /^[[({"'\-]/;

export function optionValue(value) {
  const text = String(value ?? '');
  return NEEDS_ESCAPE.test(text) ? `\\${text}` : text;
}

// deps are injectable for tests: execFile, the spawn that starts afplay, the
// error logger, the terminal-notifier lookup and the focus-argument builder.
export async function sendToast(notification, deps = {}) {
  const {
    execFileImpl = execFile,
    log = logHookError,
    notifier = findTerminalNotifier,
    focus = focusArgs,
    ...soundDeps
  } = deps;

  // A custom sound file is played by afplay (detached, so the hook does not wait
  // for it) and the notification carries no sound clause. macSoundName(path) is
  // null, so an unusable file leaves the notification on the default sound.
  const file = prepareSoundFile(notification.toastSound, 'toast:macos', { log, ...soundDeps });
  if (file) await playFirst([['afplay', [file]]], 'toast:macos', { log, ...soundDeps });

  const sound = macSoundName(notification.toastSound);
  const notifierPath = notification.clickToFocus === false ? null : notifier();
  const [bin, args] = notifierPath
    ? [notifierPath, terminalNotifierArgs(notification, { sound, silent: Boolean(file), focus: focus() })]
    : ['osascript', osascriptArgs(notification, { sound, silent: Boolean(file) })];

  return new Promise((resolve) => {
    execFileImpl(bin, args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        log('toast:macos', err, { backend: bin, stderr: (stderr || '').slice(0, 400) });
        noteFailure('toast', execFailureReason(err));
      }
      resolve(!err);
    });
  });
}

// Escape for embedding inside a double-quoted AppleScript string literal.
// Control characters are replaced with spaces: they cannot be escaped
// portably and a raw newline would otherwise break out of the string.
export function esc(str) {
  return (str || '')
    .replace(new RegExp('[\\x00-\\x1f\\x7f]', 'g'), ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}
