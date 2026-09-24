export interface CommitMessageParts {
  title: string;
  description: string;
}

interface CommitShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

export function splitCommitMessage(message: string): CommitMessageParts {
  const [title = '', ...descriptionLines] = message.replace(/\r\n?/g, '\n').split('\n');

  return {
    title: title.trim(),
    description: descriptionLines.join('\n').trim(),
  };
}

export function composeCommitMessage(title: string, description: string): string {
  const normalizedTitle = title.trim();
  const normalizedDescription = description.trim();

  return normalizedDescription
    ? `${normalizedTitle}\n\n${normalizedDescription}`
    : normalizedTitle;
}

export function hasCommitMessageTitle(message: string): boolean {
  return splitCommitMessage(message).title.length > 0;
}

export function isCommitSubmitShortcut(
  event: CommitShortcutEvent,
  keyboardShortcutsEnabled: boolean,
  canSubmit: boolean,
): boolean {
  return keyboardShortcutsEnabled
    && canSubmit
    && !event.repeat
    && event.key === 'Enter'
    && (event.ctrlKey || event.metaKey);
}
