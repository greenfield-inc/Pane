import fs from 'fs';
import path from 'path';

/**
 * What of a Session folder travels: everything except the parts Pane or Agent Farm write again on
 * the target (Pane's own AGENTS.md and CLAUDE.md sections, the wrap-up skills, the WSL runtime
 * folder, Agent Farm's generated launch folders).
 */
const REGENERATED = [/^AGENTS\.md$/, /^CLAUDE\.md$/, /^\.agent-farm\/generated(?:\/|$)/, /^\.claude\/skills\/wrap-up(?:\/|$)/, /^\.agents\/skills\/wrap-up(?:\/|$)/, /^\.pane-runtime(?:\/|$)/, /^moved\.json$/];
const SKIPPED_DIRS = new Set(['node_modules', '.git']);
const TEXT = /\.(?:md|markdown|txt|json|jsonl|ya?ml|toml|html?|css|js|mjs|cjs|ts|tsx|jsx|sh|py|csv|tsv|svg|xml|ini|env|log)$/i;

export function isRegeneratedSessionFile(relative: string): boolean {
  return REGENERATED.some(pattern => pattern.test(relative));
}

/** Text files get their paths rewritten; any other file travels byte for byte. */
export function isTextFile(relative: string): boolean {
  return TEXT.test(relative) || !path.posix.basename(relative).includes('.');
}

/** Every file of the Session folder that travels, as `/`-separated paths relative to it. Symlinks stay behind. */
export function listSessionFolder(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string, prefix: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !isRegeneratedSessionFile(relative)) walk(path.join(directory, entry.name), relative);
      } else if (entry.isFile() && !isRegeneratedSessionFile(relative)) {
        files.push(relative);
      }
    }
  };
  walk(root, '');
  return files.sort();
}
