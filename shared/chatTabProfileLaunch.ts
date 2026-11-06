import type { ChatTabLaunch } from './types/chatTab';

export type ChatTabProfileLaunch = Extract<ChatTabLaunch, { kind: 'profile' }>;

export type ChatTabProfileLaunchResult =
  | { ok: true; launch: ChatTabProfileLaunch }
  | { ok: false; field: 'profile' | 'args'; error: string };

/**
 * The "Agent Farm profile…" form's launch, the same one `runpane panels create
 * --agent-farm <profile> --arg key=value` sends: a profile name and one
 * `key=value` per line (blank lines skipped; the value keeps any `=` after the first).
 */
export function chatTabProfileLaunch(profileText: string, argsText: string): ChatTabProfileLaunchResult {
  const profile = profileText.trim();
  if (!profile) return { ok: false, field: 'profile', error: 'Enter a profile name, such as greenfield/implementer.' };
  if (/\s/.test(profile)) return { ok: false, field: 'profile', error: `"${profile}" is not a profile name: profile names have no spaces.` };
  const args: Record<string, string> = {};
  for (const raw of argsText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const separator = line.indexOf('=');
    const key = separator > 0 ? line.slice(0, separator).trim() : '';
    if (!key) return { ok: false, field: 'args', error: `"${line}" is not an argument. Write one key=value per line.` };
    args[key] = line.slice(separator + 1);
  }
  return { ok: true, launch: Object.keys(args).length > 0 ? { kind: 'profile', profile, args } : { kind: 'profile', profile } };
}
