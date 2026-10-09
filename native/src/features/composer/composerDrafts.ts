import { File, Paths } from 'expo-file-system';

/**
 * Unsent composer text per host, pane and terminal tab, kept on this device
 * so it survives leaving the pane and restarting the app. One JSON file,
 * read once and rewritten on change.
 */
const file = new File(Paths.document, 'composer-drafts.json');
let drafts: Record<string, string> | null = null;

function all(): Record<string, string> {
  if (drafts) return drafts;
  try {
    drafts = file.exists ? (JSON.parse(file.textSync()) as Record<string, string>) : {};
  } catch {
    drafts = {};
  }
  return drafts;
}

export function draftKey(hostId: string, paneId: string, panelId: string): string {
  return `${hostId}/${paneId}/${panelId}`;
}

export function readDraft(key: string): string {
  return all()[key] ?? '';
}

/** Saves `text` for `key`; empty text removes it. */
export function writeDraft(key: string, text: string): void {
  const current = all();
  if ((current[key] ?? '') === text) return;
  if (text) current[key] = text;
  else delete current[key];
  try {
    file.write(JSON.stringify(current));
  } catch {
    // A draft is a convenience; losing one must never break typing.
  }
}
