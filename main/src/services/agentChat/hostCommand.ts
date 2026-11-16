import { PaneError } from '../../../../shared/paneError';
import { quoteShellWord } from '../agents/shellWord';
import { existsSync, readFileSync, realpathSync } from 'fs';
import path from 'path';
import { getShellPath } from '../../utils/shellPath';

/**
 * Standard npm shims name their actual script. Resolve only the script the agent's
 * config names (`chat.adapter.npmShimScript`, relative to node_modules); never
 * substitute another installed CLI or infer a wrapper.
 */
export function npmShimScript(executable: string, relative: string | undefined): string | undefined {
  if (!relative || !/\.(cmd|bat)$/i.test(executable)) return;
  const wrapper = readFileSync(executable, 'utf8').replace(/\\/g, '/');
  if (!wrapper.includes(relative)) return;
  const candidates = [path.join(path.dirname(executable), 'node_modules', relative), path.join(path.dirname(executable), '..', relative)];
  return candidates.find(candidate => existsSync(candidate));
}

export function nativeCommand(executable: string, args: string[], shellType: string): string {
  const words = [executable, ...args].map(word => quoteShellWord(word, shellType));
  if (words.some(word => word === undefined)) throw new PaneError('CHAT_COMMAND_UNREPRESENTABLE', 'The selected shell cannot pass this launch configuration literally. No replacement was started.', 'Select PowerShell or a POSIX shell for this launch configuration.');
  const shell = shellType.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '');
  return `${shell === 'powershell' || shell === 'pwsh' ? '& ' : ''}${words.join(' ')}`;
}

/** Node cannot exec a Windows npm shim directly. Keep command construction at
 * this boundary and reject words cmd would expand instead of using shell:true. */
export interface HostCommand {
  executable: string; args: string[]; windowsVerbatimArguments?: boolean;
}
export function hostCommand(executable: string, args: string[], platform: NodeJS.Platform = process.platform): HostCommand {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return { executable, args };
  const words = [executable, ...args].map(word => quoteShellWord(word, 'cmd'));
  if (words.some(word => word === undefined)) {
    throw new PaneError('CHAT_COMMAND_UNREPRESENTABLE', 'The Windows command contains a value that cmd cannot pass literally. No process was started.', 'Use the provider executable directly or a path without cmd expansion characters.');
  }
  return { executable: 'cmd.exe', args: ['/d', '/s', '/c', `"${words.join(' ')}"`], windowsVerbatimArguments: true };
}

/**
 * The environment for running a tool Pane found on the shell PATH, such as npm: the tool's own
 * folder (and its link target's) goes first, then the shell PATH, so its `#!/usr/bin/env node`
 * finds the Node installed beside it, and its scripts find the person's tools, even when Pane was
 * started from Finder with a bare PATH.
 */
export function besideItsNode(executable: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH';
  const folders = new Set([path.dirname(executable), path.dirname(realpathSync(executable)), ...getShellPath().split(path.delimiter).filter(Boolean)]);
  return { ...env, [key]: [...folders].join(path.delimiter) };
}
