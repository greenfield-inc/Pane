import type { IpcMain } from 'electron';
import { shell } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { glob } from 'glob';
import { hasCommitMessageTitle } from '../../../shared/utils/commitMessage';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import type { Session } from '../types/session';
import { getGitAttributionEnv } from '../utils/attribution';
import { commandExecutor } from '../utils/commandExecutor';
import { buildGitCommitCommand } from '../utils/shellEscape';
import { revealInFileManager } from '../utils/revealInFileManager';

interface FileReadRequest {
  sessionId: string;
  filePath: string;
}

interface FileWriteRequest {
  sessionId: string;
  filePath: string;
  content: string;
}

interface FileWriteBinaryRequest {
  sessionId: string;
  fileName: string;
  contentBase64: string;
  targetDir?: string;
}

interface FilePathRequest {
  sessionId: string;
  filePath: string;
}

interface FileListRequest {
  sessionId: string;
  path?: string;
}

interface FileDeleteRequest {
  sessionId: string;
  filePath: string;
  useTrash?: boolean;
  allowPermanentFallback?: boolean;
}

interface FileRenameRequest {
  sessionId: string;
  filePath: string;
  newName: string;
}

interface FileMoveRequest {
  sessionId: string;
  sourcePath: string;
  targetDir: string;
}

interface FileCopyRequest {
  sessionId: string;
  sourcePath: string;
  targetDir: string;
  newName?: string;
}

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: Date;
}

interface FileSearchRequest {
  sessionId?: string;
  projectId?: number;
  pattern: string;
  limit?: number;
}

const DAEMON_FILE_CHANNELS = [
  'file:read',
  'file:read-binary',
  'file:exists',
  'file:write',
  'file:write-binary',
  'file:getPath',
  'git:commit',
  'git:revert',
  'git:restore',
  'file:readAtRevision',
  'file:list',
  'file:delete',
  'file:rename',
  'file:move',
  'file:copy',
  'file:duplicate',
  'file:search',
  'file:read-project',
  'file:write-project',
  'git:execute-project',
  'file:resolveAbsolutePath',
] as const;

export function registerFileHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const { sessionManager, gitStatusManager, configManager } = services;

  async function resolveWorktreePath(sessionId: string, relativePath = ''): Promise<{
    session: Session;
    basePath: string;
    fullPath: string;
    normalizedPath: string;
  }> {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const ctx = sessionManager.getProjectContext(sessionId);
    if (!ctx) throw new Error('Project not found for session');
    const { pathResolver } = ctx;

    const normalizedPath = relativePath ? path.normalize(relativePath) : '';
    if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
      throw new Error('Invalid path');
    }

    const basePath = pathResolver.toFileSystem(session.worktreePath);
    const fullPath = normalizedPath ? path.join(basePath, normalizedPath) : basePath;

    if (!await pathResolver.isWithin(basePath, fullPath)) {
      throw new Error('File path is outside worktree');
    }

    return { session, basePath, fullPath, normalizedPath };
  }

  function validateSimpleName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') {
      throw new Error('Name is required');
    }
    if (trimmed.includes('/') || trimmed.includes('\\') || path.basename(trimmed) !== trimmed) {
      throw new Error('Name must not contain path separators');
    }
    return trimmed;
  }

  async function uniqueDestinationPath(dirPath: string, requestedName: string): Promise<{ fullPath: string; name: string }> {
    const parsed = path.parse(requestedName);
    let candidateName = requestedName;
    let candidatePath = path.join(dirPath, candidateName);
    let counter = 1;

    while (await fileExists(candidatePath)) {
      candidateName = counter === 1
        ? `${parsed.name} copy${parsed.ext}`
        : `${parsed.name} copy ${counter}${parsed.ext}`;
      candidatePath = path.join(dirPath, candidateName);
      counter++;
    }

    return { fullPath: candidatePath, name: candidateName };
  }

  // Read file contents from a session's worktree
  commandRegistry.register('file:read', async (request: FileReadRequest) => {
    try {
      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) throw new Error('Project not found for session');
      const { pathResolver } = ctx;

      // Ensure the file path is relative and safe
      const normalizedPath = path.normalize(request.filePath);
      if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
        throw new Error('Invalid file path');
      }

      const basePath = pathResolver.toFileSystem(session.worktreePath);
      const fullPath = path.join(basePath, normalizedPath);

      // Verify the file is within the worktree using PathResolver
      if (!await pathResolver.isWithin(basePath, fullPath)) {
        throw new Error('File path is outside worktree');
      }

      const content = await fs.readFile(fullPath, 'utf-8');
      return { success: true, content };
    } catch (error) {
      console.error('Error reading file:', error);
      console.error('Stack:', error instanceof Error ? error.stack : 'No stack');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Read a file as binary (base64-encoded) — used for image/PDF preview
  commandRegistry.register('file:read-binary', async (request: FileReadRequest) => {
    try {
      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) throw new Error('Project not found for session');
      const { pathResolver } = ctx;

      const normalizedPath = path.normalize(request.filePath);
      if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
        throw new Error('Invalid file path');
      }

      const basePath = pathResolver.toFileSystem(session.worktreePath);
      const fullPath = path.join(basePath, normalizedPath);

      if (!await pathResolver.isWithin(basePath, fullPath)) {
        throw new Error('File path is outside worktree');
      }

      const buffer = await fs.readFile(fullPath);
      return { success: true, contentBase64: buffer.toString('base64') };
    } catch (error) {
      console.error('Error reading binary file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Check if a file exists in a session's worktree
  commandRegistry.register('file:exists', async (request: FilePathRequest) => {
    try {
      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        return false;
      }

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) return false;
      const { pathResolver } = ctx;

      // Ensure the file path is relative and safe
      const normalizedPath = path.normalize(request.filePath);
      if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
        return false;
      }

      const basePath = pathResolver.toFileSystem(session.worktreePath);
      const fullPath = path.join(basePath, normalizedPath);

      try {
        await fs.access(fullPath);
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  });

  // Write file contents to a session's worktree
  commandRegistry.register('file:write', async (request: FileWriteRequest) => {
    try {
      // Removed verbose logging of file:write requests to reduce console noise during auto-save

      if (!request.filePath) {
        throw new Error('File path is required');
      }

      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) throw new Error('Project not found for session');
      const { pathResolver } = ctx;

      if (!session.worktreePath) {
        throw new Error(`Session worktree path is undefined for session: ${request.sessionId}`);
      }

      // Ensure the file path is relative and safe
      const normalizedPath = path.normalize(request.filePath);
      if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
        throw new Error('Invalid file path');
      }

      const basePath = pathResolver.toFileSystem(session.worktreePath);
      const fullPath = path.join(basePath, normalizedPath);

      // Verify the file is within the worktree using PathResolver
      if (!await pathResolver.isWithin(basePath, fullPath)) {
        throw new Error('File path is outside worktree');
      }

      // Create directory if it doesn't exist
      const dirPath = path.dirname(fullPath);
      await fs.mkdir(dirPath, { recursive: true });

      // Write the file
      await fs.writeFile(fullPath, request.content, 'utf-8');

      return { success: true };
    } catch (error) {
      console.error('Error writing file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Helper for checking file existence
  async function fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // Write binary file to a session's worktree root (for drag-and-drop uploads)
  commandRegistry.register('file:write-binary', async (request: FileWriteBinaryRequest) => {
    try {
      if (!request.fileName) {
        throw new Error('File name is required');
      }

      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) throw new Error('Project not found for session');
      const { pathResolver } = ctx;

      if (!session.worktreePath) {
        throw new Error(`Session worktree path is undefined for session: ${request.sessionId}`);
      }

      const basePath = pathResolver.toFileSystem(session.worktreePath);
      const targetDir = request.targetDir || '';
      if (targetDir) {
        const normalizedTargetDir = path.normalize(targetDir);
        if (normalizedTargetDir.startsWith('..') || path.isAbsolute(normalizedTargetDir)) {
          throw new Error('Invalid target directory');
        }
      }

      // Validate fileName: must be a simple filename, no slashes or ..
      const sanitized = path.basename(request.fileName);
      if (!sanitized || sanitized === '.' || sanitized === '..') {
        throw new Error('Invalid file name');
      }

      // Resolve full path and verify it's within worktree
      let finalName = sanitized;
      const targetDirPath = targetDir ? path.join(basePath, targetDir) : basePath;
      if (!await pathResolver.isWithin(basePath, targetDirPath)) {
        throw new Error('Target directory is outside worktree');
      }
      await fs.mkdir(targetDirPath, { recursive: true });

      let fullPath = path.join(targetDirPath, finalName);

      if (!await pathResolver.isWithin(basePath, fullPath)) {
        throw new Error('File path is outside worktree');
      }

      // Auto-rename if file already exists
      if (await fileExists(fullPath)) {
        const ext = path.extname(sanitized);
        const base = path.basename(sanitized, ext);
        let counter = 1;
        while (await fileExists(fullPath)) {
          finalName = `${base} (${counter})${ext}`;
          fullPath = path.join(targetDirPath, finalName);
          counter++;
        }
      }

      // Write binary content
      const buffer = Buffer.from(request.contentBase64, 'base64');
      await fs.writeFile(fullPath, buffer);

      return { success: true, finalFileName: finalName, filePath: targetDir ? path.join(targetDir, finalName) : finalName };
    } catch (error) {
      console.error('Error writing binary file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Get the full path for a file in a session's worktree
  commandRegistry.register('file:getPath', async (request: FilePathRequest) => {
    try {
      const { fullPath } = await resolveWorktreePath(request.sessionId, request.filePath);
      return { success: true, path: fullPath, url: pathToFileURL(fullPath).href };
    } catch (error) {
      console.error('Error getting file path:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Commit changes in a session's worktree
  commandRegistry.register('git:commit', async (request: { sessionId: string; message: string }) => {
    try {
      if (!hasCommitMessageTitle(request.message)) {
        throw new Error('Commit title is required');
      }

      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) throw new Error('Project not found for session');
      const { commandRunner } = ctx;

      try {
        // Stage all changes
        await commandRunner.execAsync('git add -A', session.worktreePath);

        // Check if Pane footer is enabled (default: true)
        const config = configManager.getConfig();
        const enableCommitFooter = config?.enableCommitFooter !== false;

        // Build platform-safe git commit command
        const commitCommand = buildGitCommitCommand(request.message, enableCommitFooter);
        await commandExecutor.execAsync(commitCommand, {
          cwd: session.worktreePath,
          timeout: 120_000,
          env: { ...process.env, ...getGitAttributionEnv(config) }
        }, commandRunner.wslContext);

        // Refresh git status for this session after commit
        try {
          await gitStatusManager.refreshSessionGitStatus(request.sessionId, false);
        } catch (error) {
          // Git status refresh failures are logged by GitStatusManager
          console.error('Failed to refresh git status after commit:', error);
        }

        return { success: true };
      } catch (error: unknown) {
        // Check if it's a pre-commit hook failure
        if (error instanceof Error && error.message.includes('pre-commit hook')) {
          // Try to commit again in case the pre-commit hook made changes
          try {
            await commandRunner.execAsync('git add -A', session.worktreePath);

            // Check if Pane footer is enabled (default: true)
            const config = configManager.getConfig();
            const enableCommitFooter = config?.enableCommitFooter !== false;

            // Build platform-safe git commit command
            const retryCommitCommand = buildGitCommitCommand(request.message, enableCommitFooter);
            await commandExecutor.execAsync(retryCommitCommand, {
              cwd: session.worktreePath,
              timeout: 120_000,
              env: { ...process.env, ...getGitAttributionEnv(config) }
            }, commandRunner.wslContext);

            // Refresh git status for this session after commit
            try {
              await gitStatusManager.refreshSessionGitStatus(request.sessionId, false);
            } catch (error) {
              // Git status refresh failures are logged by GitStatusManager
              console.error('Failed to refresh git status after commit (retry):', error);
            }

            return { success: true };
          } catch (retryError: unknown) {
            throw new Error(`Git commit failed: ${retryError instanceof Error ? retryError.message : retryError}`);
          }
        }
        throw new Error(`Git commit failed: ${error instanceof Error ? error.message : error}`);
      }
    } catch (error) {
      console.error('Error committing changes:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Revert a specific commit
  commandRegistry.register('git:revert', async (request: { sessionId: string; commitHash: string }) => {
    try {
      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }

      if (!request.commitHash) {
        throw new Error('Commit hash is required');
      }

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) throw new Error('Project not found for session');
      const { commandRunner } = ctx;

      try {
        // Create a revert commit
        const command = `git revert ${request.commitHash} --no-edit`;
        await commandRunner.execAsync(command, session.worktreePath);

        return { success: true };
      } catch (error: unknown) {
        throw new Error(`Git revert failed: ${error instanceof Error ? error.message : error}`);
      }
    } catch (error) {
      console.error('Error reverting commit:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Restore all uncommitted changes
  commandRegistry.register('git:restore', async (request: { sessionId: string }) => {
    try {
      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) throw new Error('Project not found for session');
      const { commandRunner } = ctx;

      try {
        // Reset all changes to the last commit
        await commandRunner.execAsync('git reset --hard HEAD', session.worktreePath);

        // Clean untracked files
        await commandRunner.execAsync('git clean -fd', session.worktreePath);

        return { success: true };
      } catch (error: unknown) {
        throw new Error(`Git restore failed: ${error instanceof Error ? error.message : error}`);
      }
    } catch (error) {
      console.error('Error restoring changes:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Read file contents at a specific git revision
  commandRegistry.register('file:readAtRevision', async (request: { sessionId: string; filePath: string; revision?: string }) => {
    try {
      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }

      // Ensure the file path is relative and safe
      const normalizedPath = path.normalize(request.filePath);
      if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
        throw new Error('Invalid file path');
      }

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) throw new Error('Project not found for session');
      const { commandRunner } = ctx;

      try {
        // Default to HEAD if no revision specified
        const revision = request.revision || 'HEAD';

        // Use git show to get file content at specific revision
        // Use forward slashes for git pathspec (path.normalize uses backslashes on Windows)
        const posixPath = normalizedPath.replace(/\\/g, '/');
        const { stdout } = await commandRunner.execAsync(
          `git show ${revision}:${posixPath}`,
          session.worktreePath
        );

        return { success: true, content: stdout };
      } catch (error: unknown) {
        // If file doesn't exist at that revision, return empty content
        if (error instanceof Error && (error.message.includes('does not exist') || error.message.includes('bad file'))) {
          return { success: true, content: '' };
        }
        throw new Error(`Failed to read file at revision: ${error instanceof Error ? error.message : error}`);
      }
    } catch (error) {
      console.error('Error reading file at revision:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // List files and directories in a session's worktree
  commandRegistry.register('file:list', async (request: FileListRequest) => {
    try {
      const session = sessionManager.getSession(request.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${request.sessionId}`);
      }

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) throw new Error('Project not found for session');
      const { pathResolver } = ctx;

      // Check if session is archived - worktree won't exist
      if (session.archived) {
        return { success: false, error: 'Cannot list files for archived session' };
      }

      // Use the provided path or default to root
      const relativePath = request.path || '';

      // Ensure the path is relative and safe
      if (relativePath) {
        const normalizedPath = path.normalize(relativePath);
        if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
          throw new Error('Invalid path');
        }
      }

      const basePath = pathResolver.toFileSystem(session.worktreePath);
      const targetPath = relativePath ? path.join(basePath, relativePath) : basePath;

      // Read directory contents
      const entries = await fs.readdir(targetPath, { withFileTypes: true });

      // Process each entry
      const files: FileItem[] = await Promise.all(
        entries
          .filter(entry => entry.name !== '.git') // Exclude .git directory only
          .map(async (entry) => {
            const fullPath = path.join(targetPath, entry.name);
            const relativePath = pathResolver.relative(basePath, fullPath);

            try {
              const stats = await fs.stat(fullPath);
              return {
                name: entry.name,
                path: relativePath,
                isDirectory: entry.isDirectory(),
                size: entry.isFile() ? stats.size : undefined,
                modified: stats.mtime
              };
            } catch {
              // Handle broken symlinks or inaccessible files
              return {
                name: entry.name,
                path: relativePath,
                isDirectory: entry.isDirectory()
              };
            }
          })
      );

      // Sort: directories first, then alphabetically
      files.sort((a, b) => {
        if (a.isDirectory === b.isDirectory) {
          return a.name.localeCompare(b.name);
        }
        return a.isDirectory ? -1 : 1;
      });

      return { success: true, files };
    } catch (error) {
      console.error('Error listing files:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Delete a file from a session's worktree
  commandRegistry.register('file:delete', async (request: FileDeleteRequest) => {
    try {
      const { fullPath, normalizedPath } = await resolveWorktreePath(request.sessionId, request.filePath);

      // Check if the file exists
      try {
        await fs.access(fullPath);
      } catch {
        throw new Error(`File not found: ${normalizedPath}`);
      }

      // Check if it's a directory or file
      const stats = await fs.stat(fullPath);

      if (request.useTrash !== false) {
        try {
          await shell.trashItem(fullPath);
          return { success: true };
        } catch (trashError) {
          if (request.allowPermanentFallback === false) {
            return {
              success: false,
              error: trashError instanceof Error ? trashError.message : 'Failed to move item to trash'
            };
          }
          console.warn('Failed to move item to trash, permanently deleting instead:', trashError);
        }
      }

      if (stats.isDirectory()) {
        // For directories, use rm with recursive option
        await fs.rm(fullPath, { recursive: true, force: true });
      } else {
        // For files, use unlink
        await fs.unlink(fullPath);
      }

      return { success: true };
    } catch (error) {
      console.error('Error deleting file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Rename a file or folder within a session's worktree
  commandRegistry.register('file:rename', async (request: FileRenameRequest) => {
    try {
      const { basePath, fullPath, normalizedPath } = await resolveWorktreePath(request.sessionId, request.filePath);
      const newName = validateSimpleName(request.newName);
      const parentDir = path.dirname(fullPath);
      const newFullPath = path.join(parentDir, newName);

      const relativeToBase = path.relative(basePath, newFullPath);
      if (relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
        throw new Error('Target path is outside worktree');
      }
      if (await fileExists(newFullPath)) {
        throw new Error(`An item named "${newName}" already exists`);
      }

      await fs.rename(fullPath, newFullPath);
      const parentRelative = path.dirname(normalizedPath);
      const newPath = parentRelative === '.' ? newName : path.join(parentRelative, newName);
      return { success: true, path: newPath };
    } catch (error) {
      console.error('Error renaming file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Move a file or folder into a target directory within a session's worktree
  commandRegistry.register('file:move', async (request: FileMoveRequest) => {
    try {
      const source = await resolveWorktreePath(request.sessionId, request.sourcePath);
      const target = await resolveWorktreePath(request.sessionId, request.targetDir);

      const sourceName = path.basename(source.fullPath);
      const targetStats = await fs.stat(target.fullPath);
      if (!targetStats.isDirectory()) {
        throw new Error('Target must be a directory');
      }

      if (source.fullPath === target.fullPath || target.fullPath.startsWith(source.fullPath + path.sep)) {
        throw new Error('Cannot move a folder into itself');
      }

      const destinationPath = path.join(target.fullPath, sourceName);
      if (await fileExists(destinationPath)) {
        throw new Error(`An item named "${sourceName}" already exists in the target folder`);
      }

      await fs.rename(source.fullPath, destinationPath);
      const newPath = request.targetDir ? path.join(request.targetDir, sourceName) : sourceName;
      return { success: true, path: newPath };
    } catch (error) {
      console.error('Error moving file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Copy a file or folder into a target directory within a session's worktree
  commandRegistry.register('file:copy', async (request: FileCopyRequest) => {
    try {
      const source = await resolveWorktreePath(request.sessionId, request.sourcePath);
      const target = await resolveWorktreePath(request.sessionId, request.targetDir);

      const targetStats = await fs.stat(target.fullPath);
      if (!targetStats.isDirectory()) {
        throw new Error('Target must be a directory');
      }

      const requestedName = request.newName ? validateSimpleName(request.newName) : path.basename(source.fullPath);
      const destination = await uniqueDestinationPath(target.fullPath, requestedName);
      await fs.cp(source.fullPath, destination.fullPath, { recursive: true, errorOnExist: true });

      const newPath = request.targetDir ? path.join(request.targetDir, destination.name) : destination.name;
      return { success: true, path: newPath };
    } catch (error) {
      console.error('Error copying file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Duplicate a file or folder next to itself within a session's worktree
  commandRegistry.register('file:duplicate', async (request: FilePathRequest) => {
    try {
      const source = await resolveWorktreePath(request.sessionId, request.filePath);
      const parentDir = path.dirname(source.fullPath);
      const requestedName = path.basename(source.fullPath);
      const destination = await uniqueDestinationPath(parentDir, requestedName);

      await fs.cp(source.fullPath, destination.fullPath, { recursive: true, errorOnExist: true });

      const parentRelative = path.dirname(source.normalizedPath);
      const newPath = parentRelative === '.' ? destination.name : path.join(parentRelative, destination.name);
      return { success: true, path: newPath };
    } catch (error) {
      console.error('Error duplicating file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Search for files matching a pattern
  commandRegistry.register('file:search', async (request: FileSearchRequest) => {
    try {
      // Determine the search directory and get path resolver
      // storedDir = Linux path (for CommandRunner cwd), searchDirectory = filesystem path (for fs ops)
      let storedDir: string;
      let searchDirectory: string;
      let pathResolver;
      let commandRunner;

      if (request.sessionId) {
        const session = sessionManager.getSession(request.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }
        const ctx = sessionManager.getProjectContext(request.sessionId);
        if (!ctx) throw new Error('Project not found for session');
        pathResolver = ctx.pathResolver;
        commandRunner = ctx.commandRunner;
        storedDir = session.worktreePath;
        searchDirectory = pathResolver.toFileSystem(storedDir);
      } else if (request.projectId) {
        const ctx = sessionManager.getProjectContextByProjectId(request.projectId);
        if (!ctx) throw new Error('Project not found');
        const { project } = ctx;
        pathResolver = ctx.pathResolver;
        commandRunner = ctx.commandRunner;
        storedDir = project.path;
        searchDirectory = pathResolver.toFileSystem(storedDir);
      } else {
        throw new Error('Either sessionId or projectId must be provided');
      }

      // Normalize the pattern for searching
      const searchPattern = request.pattern.replace(/^@/, '').toLowerCase();
      
      // If the pattern contains a path separator, search from that path
      const pathParts = searchPattern.split(/[/\\]/);
      const searchDir = pathParts.length > 1 
        ? path.join(searchDirectory, ...pathParts.slice(0, -1))
        : searchDirectory;
      const filePattern = pathParts[pathParts.length - 1] || '';
      
      // Check if searchDir exists
      try {
        await fs.access(searchDir);
      } catch {
        return { success: true, files: [] };
      }

      // Get list of tracked files (not gitignored) using git
      const gitTrackedFiles = new Set<string>();
      let isGitRepo = true;
      try {
        // Get list of all tracked files in the repository
        // Use storedDir (Linux path) for CommandRunner, not filesystem path
        const { stdout: trackedStdout } = await commandRunner.execAsync(
          'git ls-files',
          storedDir
        );

        if (trackedStdout) {
          trackedStdout.split('\n').forEach((file: string) => {
            if (file.trim()) {
              gitTrackedFiles.add(file.trim());
            }
          });
        }

        // Also get untracked files that are not ignored
        const { stdout: untrackedStdout } = await commandRunner.execAsync(
          'git ls-files --others --exclude-standard',
          storedDir
        );

        if (untrackedStdout) {
          untrackedStdout.split('\n').forEach((file: string) => {
            if (file.trim()) {
              gitTrackedFiles.add(file.trim());
            }
          });
        }
      } catch (err) {
        // Git command failed, likely not a git repo
        isGitRepo = false;
        console.log('Could not get git tracked files:', err);
      }

      // Use glob to find matching files
      const globPattern = filePattern ? `**/*${filePattern}*` : '**/*';
      const files = await glob(globPattern, {
        cwd: searchDir,
        ignore: [
          '**/node_modules/**', 
          '**/.git/**', 
          '**/dist/**', 
          '**/build/**',
          '**/worktrees/**' // Exclude worktree folders
        ],
        nodir: false,
        dot: true,
        absolute: false,
        maxDepth: 5
      });

      // Convert to relative paths from the original directory
      const results = await Promise.all(
        files.map(async (file) => {
          const fullPath = path.join(searchDir, file);
          const relativePath = pathResolver.relative(searchDirectory, fullPath);
          
          // Skip worktree directories
          if (relativePath.includes('worktrees/') || relativePath.startsWith('worktrees/')) {
            return null;
          }
          
          // If we're in a git repo, only include tracked/untracked-but-not-ignored files
          if (isGitRepo && gitTrackedFiles.size > 0 && !gitTrackedFiles.has(relativePath)) {
            // Check if it's a directory - directories might not be in git ls-files
            try {
              const stats = await fs.stat(fullPath);
              if (!stats.isDirectory()) {
                return null; // Skip non-directory files that aren't tracked
              }
            } catch {
              return null;
            }
          }
          
          try {
            const stats = await fs.stat(fullPath);
            return {
              path: relativePath,
              isDirectory: stats.isDirectory(),
              name: path.basename(file)
            };
          } catch {
            return null;
          }
        })
      );

      // Filter out null results and apply pattern matching
      const filteredResults = results
        .filter((file): file is NonNullable<typeof file> => file !== null)
        .filter(file => {
          // Filter by the full search pattern
          return file.path.toLowerCase().includes(searchPattern);
        })
        .sort((a, b) => {
          // Sort directories first, then by path
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.path.localeCompare(b.path);
        })
        .slice(0, request.limit || 50);

      return { success: true, files: filteredResults };
    } catch (error) {
      console.error('Error searching files:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error',
        files: []
      };
    }
  });

  // Read file from project directory (not worktree)
  commandRegistry.register('file:read-project', async (request: { projectId: number; filePath: string }) => {
    console.log('[file:read-project] Request:', request);
    try {
      const ctx = sessionManager.getProjectContextByProjectId(request.projectId);
      if (!ctx) {
        console.error('[file:read-project] Project not found:', request.projectId);
        throw new Error(`Project not found: ${request.projectId}`);
      }
      const { project, pathResolver } = ctx;

      console.log('[file:read-project] Project path:', project.path);

      // Ensure the file path is relative and safe
      const normalizedPath = path.normalize(request.filePath);
      if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
        throw new Error('Invalid file path');
      }

      const storedPath = pathResolver.join(project.path, normalizedPath);
      const fullPath = pathResolver.toFileSystem(storedPath);
      console.log('[file:read-project] Full path:', fullPath);

      // Check if file exists
      try {
        await fs.access(fullPath);
        console.log('[file:read-project] File exists');
      } catch {
        // File doesn't exist, return null
        console.log('[file:read-project] File does not exist');
        return { success: true, data: null };
      }

      // Read the file
      const content = await fs.readFile(fullPath, 'utf-8');
      console.log('[file:read-project] Read', content.length, 'bytes');
      return { success: true, data: content };
    } catch (error) {
      console.error('[file:read-project] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Write file to project directory (not worktree)
  commandRegistry.register('file:write-project', async (request: { projectId: number; filePath: string; content: string }) => {
    console.log('[file:write-project] Request:', { projectId: request.projectId, filePath: request.filePath, contentLength: request.content.length });
    try {
      const ctx = sessionManager.getProjectContextByProjectId(request.projectId);
      if (!ctx) {
        console.error('[file:write-project] Project not found:', request.projectId);
        throw new Error(`Project not found: ${request.projectId}`);
      }
      const { project, pathResolver } = ctx;

      console.log('[file:write-project] Project path:', project.path);

      // Ensure the file path is relative and safe
      const normalizedPath = path.normalize(request.filePath);
      if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
        throw new Error('Invalid file path');
      }

      const storedPath = pathResolver.join(project.path, normalizedPath);
      const fullPath = pathResolver.toFileSystem(storedPath);
      console.log('[file:write-project] Full path:', fullPath);

      // Ensure directory exists
      const dir = path.dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });

      // Write the file
      await fs.writeFile(fullPath, request.content, 'utf-8');
      console.log('[file:write-project] Successfully wrote', request.content.length, 'bytes to', fullPath);

      return { success: true };
    } catch (error) {
      console.error('[file:write-project] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Execute git command in project directory
  commandRegistry.register('git:execute-project', async (request: { projectId: number; args: string[] }) => {
    console.log('[git:execute-project] Request:', request);
    try {
      const ctx = sessionManager.getProjectContextByProjectId(request.projectId);
      if (!ctx) {
        console.error('[git:execute-project] Project not found:', request.projectId);
        throw new Error(`Project not found: ${request.projectId}`);
      }

      const { project, commandRunner } = ctx;

      console.log('[git:execute-project] Project path:', project.path);
      console.log('[git:execute-project] Git command:', 'git', request.args.join(' '));

      // Build the git command with properly escaped arguments
      const command = `git ${request.args.map(arg => {
        // Properly escape arguments for shell
        if (arg.includes(' ') || arg.includes('\n') || arg.includes('"')) {
          return `"${arg.replace(/"/g, '\\"')}"`;
        }
        return arg;
      }).join(' ')}`;

      // Execute git command using CommandRunner
      const result = (await commandRunner.execAsync(command, project.path)).stdout;

      console.log('[git:execute-project] Command successful');
      return { success: true, output: result };
    } catch (error) {
      console.error('[git:execute-project] Error:', error);

      // Extract error message
      let errorMessage = 'Unknown error';
      if (error instanceof Error) {
        errorMessage = error.message;
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  });

  // Resolve an absolute filesystem path for a file in a session's worktree
  commandRegistry.register('file:resolveAbsolutePath', async (request: { sessionId: string; path?: string }) => {
    try {
      const session = sessionManager.getSession(request.sessionId);
      if (!session) throw new Error(`Session not found: ${request.sessionId}`);

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) throw new Error('Project not found for session');

      const relativePath = request.path || '';
      if (relativePath) {
        const normalizedPath = path.normalize(relativePath);
        if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
          throw new Error('Invalid path');
        }
      }

      const basePath = ctx.pathResolver.toFileSystem(session.worktreePath);
      const absolutePath = relativePath ? path.join(basePath, relativePath) : basePath;

      return { success: true, path: absolutePath };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve path' };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_FILE_CHANNELS);

  // Show a file/folder from a session's worktree in the native file manager
  ipcMain.handle('file:showInFolder', async (_, request: { sessionId: string; path?: string }) => {
    try {
      const session = sessionManager.getSession(request.sessionId);
      if (!session) throw new Error(`Session not found: ${request.sessionId}`);

      const ctx = sessionManager.getProjectContext(request.sessionId);
      if (!ctx) throw new Error('Project not found for session');

      const relativePath = request.path || '';
      if (relativePath) {
        const normalizedPath = path.normalize(relativePath);
        if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
          throw new Error('Invalid path');
        }
      }

      const basePath = ctx.pathResolver.toFileSystem(session.worktreePath);
      const targetPath = relativePath ? path.join(basePath, relativePath) : basePath;

      await revealInFileManager(targetPath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to show in folder' };
    }
  });
}
