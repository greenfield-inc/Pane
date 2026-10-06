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
      scopes.push({ scope: { kind: 'feature', id: paneId }, name: pane.name });
    }
    return { scopes: [...scopes, { scope: GLOBAL, name: 'All projects' }], defaultScope: scopes[0].scope };
  }

  function publish(): NoteExportResult[] {
    const results: NoteExportResult[] = [];
    const write = (agent: string, file: string, content: Note[]) => {
      try { exportNoteMemories(root, file, content); results.push({ agent, path: file }); return true; }
      catch (error) { results.push({ agent, path: file, error: error instanceof Error ? error.message : String(error) }); return false; }
    };
    const global = notes.list(GLOBAL);
    const codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const codexOverride = path.join(codexRoot, 'AGENTS.override.md');
    write('Claude', path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'CLAUDE.md'), global);
    write('Codex', fs.existsSync(codexOverride) ? codexOverride : path.join(codexRoot, 'AGENTS.md'), global);
    const cursorDirectory = process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), '.cursor');
    const cursorRules = path.join(cursorDirectory, 'rules', 'pane-memories.mdc');
    const cursorRulesReady = write('Cursor rules', cursorRules, global);
    if (global.length || fs.existsSync(path.join(cursorDirectory, 'pane-notes-context.json'))) {
      try {
        if (!cursorRulesReady) throw new Error('Cursor rules export failed; session context was not updated.');
        const memory = global.length
          ? `Pane memories from ${cursorRules}. Resolve drawing references relative to ${path.dirname(cursorRules)}.\n\n${fs.readFileSync(cursorRules, 'utf8')}` : '';
        exportCursorMemoryHook(cursorDirectory, memory, process.platform);
        results.push({ agent: 'Cursor CLI session context', path: path.join(cursorDirectory, 'hooks.json') });
      } catch (error) { results.push({ agent: 'Cursor CLI session context', path: path.join(cursorDirectory, 'hooks.json'), error: String(error) }); }
    }
    const targets = new Map<string, Note[]>();
    for (const project of databaseService.getAllProjects()) {
      const projectNotes = notes.list({ kind: 'project', id: String(project.id) }).filter(note => note.scope.kind !== 'global');
      targets.set(project.path, projectNotes);
      for (const pane of sessionManager.getSessionsForProject(project.id)) {
        const featureNotes = notes.list({ kind: 'feature', id: pane.id }).filter(note => note.scope.kind === 'feature');
        targets.set(pane.worktreePath, [...projectNotes, ...featureNotes]);
      }
    }
    // Session workspaces are separate from associated worker projects.
    for (const pane of databaseService.getAllSessions(undefined, { includeHidden: true })) {
      if (isOrchestrationInternalSessionId(pane.id)) targets.set(pane.worktree_path, notes.list({ kind: 'session', id: pane.id }).filter(note => note.scope.kind === 'session'));
    }
    for (const [directory, content] of targets) {
      if (!fs.existsSync(directory)) continue;
      write('Project / Codex and Cursor', path.join(directory, 'AGENTS.md'), content);
      write('Project / Claude', path.join(directory, 'CLAUDE.md'), content);
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
    if (input.action === 'create') {
      if (!input.scope) throw new Error('Choose a notebook.');
      note = notes.create(input.scope, input.title || 'Untitled note');
    } else if (input.action !== 'retry') {
      const id = input.note?.id ?? input.id;
      const revision = input.note?.revision ?? input.revision;
      if (!id || revision === undefined) throw new Error('Missing note revision.');
      const current = ctx.scopes.flatMap(item => notes.list(item.scope)).find(item => item.id === id);
      if (!current) throw new Error('Note not found in this context.');
      if (input.action === 'save') {
        if (!input.note) throw new Error('Missing note.');
        note = notes.save(input.note);
      } else if (input.action === 'move') {
        if (!input.scope) throw new Error('Choose a destination project.');
        note = notes.move(id, revision, input.scope);
      } else notes.remove(id, revision);
    }
    const exports = publish();
    services.getMainWindow()?.webContents.send('notes:changed');
    return { note, exports };
  });
  // Reconcile saved project memory when a new worktree becomes available.
  sessionManager.on('session-created', () => {
    if (fs.existsSync(path.join(root, 'notes.json'))) publish();
  });
}
