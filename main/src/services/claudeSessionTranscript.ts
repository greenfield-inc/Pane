import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/** Resolve by ID without copying vendor-owned transcripts into a new project. */
export function findClaudeSessionTranscript(sessionId: string, configDirectory = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined;
  const projects = path.join(configDirectory, 'projects');
  if (!existsSync(projects)) return undefined;
  const matches: string[] = [];
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(projects, project.name, `${sessionId}.jsonl`);
    if (existsSync(candidate) && statSync(candidate).size > 0) matches.push(candidate);
  }
  if (matches.length > 1) throw new Error(`Multiple Claude transcripts found for Session ${sessionId}; choose the conversation explicitly with a custom launch command.`);
  return matches[0];
}
