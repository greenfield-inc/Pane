interface SnapshotTerminal {
  buffer: { active: { baseY: number; viewportY: number } };
  reset(): void;
  write(text: string, done: () => void): void;
  scrollToLine(line: number): void;
}

/** Reads may outlive their event stream; only the current owner can touch xterm. */
export async function hydrateRemoteTerminalSnapshot(
  terminal: SnapshotTerminal,
  read: () => Promise<string>,
  owns: () => boolean,
): Promise<boolean> {
  const text = await read();
  if (!owns()) return false;
  const distance = terminal.buffer.active.baseY - terminal.buffer.active.viewportY;
  terminal.reset();
  await new Promise<void>(resolve => terminal.write(text, resolve));
  if (!owns()) return false;
  terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - distance));
  return true;
}
