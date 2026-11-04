/**
 * Questions a shell can ask before its first prompt. A launch command typed into one is
 * taken as its answer (oh-my-zsh swallows the first character), so the launch answers it
 * and keeps waiting for the real prompt. Add a prompt here only when its answer is safe to
 * give unattended; anything that needs a person's decision is a blocker to report instead.
 */
export interface ShellStartupPrompt {
  name: string;
  pattern: RegExp;
  /** Written to the shell as is, with no Enter. */
  answer: string;
}

const SHELL_STARTUP_PROMPTS: readonly ShellStartupPrompt[] = [
  // "n" is oh-my-zsh's own "no": it also postpones the question for its update period.
  { name: 'oh-my-zsh-update', pattern: /\[oh-my-zsh\] Would you like to update\?\s*\[Y\/n\]/i, answer: 'n' },
];

const RECENT_OUTPUT_CHARS = 200;

/**
 * Feed shell output in as it arrives; returns a prompt the first time its question shows,
 * including when the question is split across chunks or styled with ANSI escapes.
 */
export function createShellStartupPromptWatcher(
  prompts: readonly ShellStartupPrompt[] = SHELL_STARTUP_PROMPTS,
): (data: string) => ShellStartupPrompt | undefined {
  let recentOutput = '';
  const answered = new Set<string>();
  return (data) => {
    if (answered.size === prompts.length) return undefined;
    // oxlint-disable-next-line eslint/no-control-regex
    recentOutput = `${recentOutput}${data}`.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').slice(-RECENT_OUTPUT_CHARS);
    const prompt = prompts.find(candidate => !answered.has(candidate.name) && candidate.pattern.test(recentOutput));
    if (!prompt) return undefined;
    answered.add(prompt.name);
    recentOutput = '';
    return prompt;
  };
}
