import type { ChatTabLaunch } from './types/chatTab';
import type { AgentFarmProfileEntry } from './types/agentFarmProfiles';
import { agentLabel } from './agents';
import { profileEntryName } from './agentProfiles';

/** One choice in the "Profile…" form's picker: a profile ref (with its variant for a non-default one) and how it reads. */
export interface ChatTabProfileOption {
  ref: string;
  label: string;
}

/**
 * The picker's choices (T-83), from `agent-farm profiles list --json`: every profile but Pane's own
 * plain ones, by Agent Farm's title and ref; a profile with variants also offers each other variant.
 */
export function chatTabProfileOptions(profiles: readonly AgentFarmProfileEntry[]): ChatTabProfileOption[] {
  return profiles.filter(entry => !entry.hidden).flatMap(entry => {
    const name = profileEntryName(entry);
    const others = (entry.variants ?? []).filter(variant => variant.name !== (entry.defaultVariant ?? entry.variants?.[0]?.name));
    return [
      { ref: entry.ref, label: `${name} · ${entry.ref}` },
      ...others.map(variant => ({ ref: `${entry.ref}:${variant.name}`, label: `${name} (${agentLabel(variant.name)}) · ${entry.ref}:${variant.name}` })),
    ];
  });
}

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
  if (!profile) return { ok: false, field: 'profile', error: 'Enter a profile name, such as greenfield/orchestrator.' };
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
