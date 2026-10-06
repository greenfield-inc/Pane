import type { IpcMain } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AppServices } from './types';
import { getAppDirectory } from '../utils/appDirectory';
import { Notes } from '../services/notes';
import { exportNoteMemories } from '../services/noteExports';
import { exportCursorMemoryHook } from '../services/cursorNoteHook';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { noteSchema, noteScopeSchema, sameNoteScope, type Note, type NoteContext, type NoteScope, type NoteExportResult, type NoteMutation } from '../../../shared/types/notes';
import { isOrchestrationInternalSessionId } from '../../../shared/types/orchestrationSession';
import type { Session } from '../types/session';
import { noteContextPath, SCOPED_NOTE_INSTRUCTIONS } from '../services/noteFiles';

const GLOBAL: NoteScope = { kind: 'global', id: 'user' };

export function registerNotesHandlers(ipcMain: IpcMain, services: AppServices): void {
  const root = path.join(getAppDirectory(), 'notes');
  const notes = new Notes(root);
  const { sessionManager, databaseService, orchestrationSessionManager } = services;

  async function context(paneId: string): Promise<NoteContext> {
    const pane = sessionManager.getSession(paneId);
    if (!pane) throw new Error('Pane not found.');
    const scopes: NoteContext['scopes'] = [];
    if (isOrchestrationInternalSessionId(paneId)) {
      const record = (await orchestrationSessionManager?.list())?.sessions.find(item => item.internalSessionId === paneId);
      if (!record) throw new Error('Session not found.');
      scopes.push({ scope: { kind: 'session', id: paneId }, name: record.name });
      const projectIds = new Set(record.associations.map(item => sessionManager.getSession(item.paneId)?.projectId));
      for (const id of projectIds) {
        const project = id ? databaseService.getProject(id) : undefined;
        if (project) scopes.push({ scope: { kind: 'project', id: String(project.id) }, name: project.name });
      }
    } else {
      const project = pane.projectId ? databaseService.getProject(pane.projectId) : undefined;
      if (!project) throw new Error('Project not found.');
      scopes.push({ scope: { kind: 'project', id: String(project.id) }, name: project.name });
      if (!pane.isMainRepo) scopes.push({ scope: { kind: 'feature', id: paneId }, name: pane.name });
    }
    return { scopes: [...scopes, { scope: GLOBAL, name: 'All projects' }], defaultScope: scopes[0].scope };
  }

  function publish(changed?: NoteScope[]): NoteExportResult[] {
    const results: NoteExportResult[] = [];
    const all = notes.all();
    const owned = (scope: NoteScope) => all.filter(note => sameNoteScope(note.scope, scope));
    const affected = (scope: NoteScope) => !changed || changed.some(item => sameNoteScope(item, scope));
    const write = (agent: string, file: string, content: Note[], preamble = '') => {
      try { exportNoteMemories(root, file, content, preamble); results.push({ agent, path: file }); return true; }
      catch (error) { results.push({ agent, path: file, error: error instanceof Error ? error.message : String(error) }); return false; }
    };
    // The small user-level loader is stable across scoped edits. Agents read the
    // private context file supplied by their terminal, keeping repositories clean.
    const preamble = all.some(note => note.scope.kind !== 'global') ? SCOPED_NOTE_INSTRUCTIONS : '';
    const global = owned(GLOBAL);
    const codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const codexOverride = path.join(codexRoot, 'AGENTS.override.md');
    write('Claude', path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'CLAUDE.md'), global, preamble);
    write('Codex', fs.existsSync(codexOverride) ? codexOverride : path.join(codexRoot, 'AGENTS.md'), global, preamble);
    const cursorDirectory = process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), '.cursor');
    const cursorRules = path.join(cursorDirectory, 'rules', 'pane-memories.mdc');
    const cursorRulesReady = write('Cursor rules', cursorRules, global, preamble);
    if (global.length || preamble || fs.existsSync(path.join(cursorDirectory, 'pane-notes-context.json'))) {
      try {
        if (!cursorRulesReady) throw new Error('Cursor rules export failed; session context was not updated.');
        const memory = global.length || preamble
          ? `Pane memories from ${cursorRules}. Resolve drawing references relative to ${path.dirname(cursorRules)}.\n\n${fs.readFileSync(cursorRules, 'utf8')}` : '';
        exportCursorMemoryHook(cursorDirectory, memory, process.platform);
        results.push({ agent: 'Cursor CLI session context', path: path.join(cursorDirectory, 'hooks.json') });
      } catch (error) { results.push({ agent: 'Cursor CLI session context', path: path.join(cursorDirectory, 'hooks.json'), error: String(error) }); }
    }
    const targets = new Map<string, Note[]>();
    const repositoryExports = services.configManager.getConfig().agentContext?.managedAgentsMd === true;
    for (const project of databaseService.getAllProjects()) {
      const projectScope: NoteScope = { kind: 'project', id: String(project.id) };
      const projectNotes = owned(projectScope);
      const projectChanged = affected(projectScope);
      const panes = sessionManager.getSessionsForProject(project.id);
      if (project.wsl_enabled) {
        if (projectChanged || panes.some(pane => affected({ kind: 'feature', id: pane.id }))) {
          results.push({ agent: 'WSL agents', path: project.path, error: 'Notes are saved, but WSL agent exports are not supported. Windows user exports apply only to native Windows agents.' });
        }
        continue;
      }
      if (projectChanged) {
        targets.set(project.path, repositoryExports ? projectNotes : []);
        const main = databaseService.getMainRepoSession(project.id);
        if (main) write('Pane agent context', noteContextPath(root, main.id), projectNotes);
      }
      for (const pane of panes) {
        const featureScope: NoteScope = { kind: 'feature', id: pane.id };
        if (!projectChanged && !affected(featureScope)) continue;
        const featureNotes = owned(featureScope);
        const content = [...projectNotes, ...featureNotes];
        write('Pane agent context', noteContextPath(root, pane.id), content);
        targets.set(pane.worktreePath, repositoryExports ? content : []);
      }
    }
    // Session workspaces are separate from associated worker projects.
    for (const pane of databaseService.getAllSessions(undefined, { includeHidden: true })) {
      const scope: NoteScope = { kind: 'session', id: pane.id };
      if (isOrchestrationInternalSessionId(pane.id) && affected(scope)) {
        write('Pane agent context', noteContextPath(root, pane.id), owned(scope));
        targets.set(pane.worktree_path, repositoryExports ? owned(scope) : []);
      }
    }
    for (const [directory, content] of targets) {
      try {
        if (!fs.existsSync(directory)) {
          if (content.length) results.push({ agent: 'Project agents', path: directory, error: 'Workspace is unavailable. Retry exports when it is accessible.' });
          continue;
        }
        if (!repositoryExports && !['AGENTS.md', 'CLAUDE.md'].some(name => {
          const file = path.join(directory, name);
          return fs.existsSync(file) && fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').includes('<!-- pane-memories:start -->');
        })) continue;
        write('Project / Codex and Cursor', path.join(directory, 'AGENTS.md'), content);
        const claude = path.join(directory, 'CLAUDE.md');
        // Session workspaces and many repos already import the shared instructions.
        const importsAgents = fs.existsSync(claude) && /^\s*@(?:\.\/)?AGENTS\.md\s*$/m.test(fs.readFileSync(claude, 'utf8'));
        write('Project / Claude', claude, importsAgents ? [] : content);
      } catch (error) {
        results.push({ agent: 'Repository instructions', path: directory, error: String(error) });
      }
    }
    return results;
  }

  ipcMain.handle('notes:context', async (_, paneId: string) => context(decodeBoundary(paneId, boundary.nonEmptyString)));
  ipcMain.handle('notes:list', async (_, paneId: string, rawScope: NoteScope) => {
    const ctx = await context(decodeBoundary(paneId, boundary.nonEmptyString));
    const scope = decodeBoundary(rawScope, noteScopeSchema);
    if (!ctx.scopes.some(item => sameNoteScope(item.scope, scope))) throw new Error('Notebook is outside this context.');
    return notes.list(scope);
  });
  ipcMain.handle('notes:mutate', async (_, rawPaneId: string, raw: NoteMutation) => {
    const paneId = decodeBoundary(rawPaneId, boundary.nonEmptyString);
    const ctx = await context(paneId);
    const input = decodeBoundary(raw, boundary.object({
      action: boundary.enumeration('create', 'save', 'move', 'remove', 'retry'),
      scope: boundary.optional(noteScopeSchema), note: boundary.optional(noteSchema),
      title: boundary.optional(boundary.string), id: boundary.optional(boundary.string), revision: boundary.optional(boundary.number),
    }));
    if (input.scope && !ctx.scopes.some(item => sameNoteScope(item.scope, input.scope!))) throw new Error('Select a project in this context.');
    let note: Note | undefined;
    const changed: NoteScope[] = [];
    if (input.action === 'create') {
      if (!input.scope) throw new Error('Choose a notebook.');
      note = notes.create(input.scope, input.title || 'Untitled note');
      changed.push(input.scope);
    } else if (input.action !== 'retry') {
      const id = input.note?.id ?? input.id;
      const revision = input.note?.revision ?? input.revision;
      if (!id || revision === undefined) throw new Error('Missing note revision.');
      const current = notes.all().find(item => item.id === id && ctx.scopes.some(({ scope }) =>
        sameNoteScope(item.scope, scope) || item.references.some(ref => sameNoteScope(ref, scope))));
      if (!current) throw new Error('Note not found in this context.');
      changed.push(current.scope);
      if (input.action === 'save') {
        if (!input.note) throw new Error('Missing note.');
        note = notes.save(input.note);
      } else if (input.action === 'move') {
        if (!input.scope) throw new Error('Choose a destination project.');
        note = notes.move(id, revision, input.scope);
        changed.push(input.scope);
      } else notes.remove(id, revision);
    }
    const exports = publish(input.action === 'retry' ? undefined : changed);
    services.getMainWindow()?.webContents.send('notes:changed');
    return { note, exports };
  });
  // Publication failures must not escape into unrelated host lifecycle events.
  function reconcile(changed?: NoteScope[]): void {
    if (!fs.existsSync(path.join(root, 'notes.json'))) return;
    try { publish(changed); }
    catch (error) { console.error('Could not reconcile saved note exports:', error); }
  }
  // Reconcile saved project memory when a new worktree becomes available.
  sessionManager.on('session-created', (session: Session) => {
    reconcile([{ kind: 'project', id: String(session.projectId) }]);
  });
  let repositoryExports = services.configManager.getConfig().agentContext?.managedAgentsMd === true;
  services.configManager.on('config-updated', () => {
    const enabled = services.configManager.getConfig().agentContext?.managedAgentsMd === true;
    if (enabled !== repositoryExports) {
      repositoryExports = enabled;
      reconcile();
    }
  });
  reconcile();
}
