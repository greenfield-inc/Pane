import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as os from 'os';

interface ShellInfo {
  path: string;
  name: string;
  args?: string[];
}

interface ShellCommand {
  shell: string;
  args: string[];
}

/**
 * Detects the user's default shell in a robust, cross-platform way
 */
export class ShellDetector {
  private static cachedShell: ShellInfo | null = null;

  /**
   * Get the user's default shell
   * @param preferredShell Optional preferred shell ('auto', 'gitbash', 'powershell', 'pwsh', 'cmd')
   * @param forceRefresh Force re-detection instead of using cache
   * @returns Shell information including path and name
   */
  static getDefaultShell(preferredShell?: string, forceRefresh = false): ShellInfo {
    // If specific preference provided (not 'auto'), try to use it
    if (preferredShell && preferredShell !== 'auto') {
      const preferred = this.getShellByPreference(preferredShell);
      if (preferred) {
        return preferred;
      }
      // Preferred shell not available, fall through to auto-detect
    }

    // Use cache if available and not forcing refresh
    if (!forceRefresh && this.cachedShell) {
      return this.cachedShell;
    }

    const shell = this.detectShell();
    this.cachedShell = shell;
    return shell;
  }

  private static detectShell(): ShellInfo {
    const platform = process.platform;

    if (platform === 'win32') {
      return this.detectWindowsShell();
    } else {
      return this.detectUnixShell();
    }
  }

  private static detectWindowsShell(): ShellInfo {
    // Check for Git Bash first (top priority)
    const gitBashPath = this.findGitBash();
    if (gitBashPath) {
      return { path: gitBashPath, name: 'gitbash', args: this.getShellArgs('gitbash') };
    }

    // Check for PowerShell Core
    const pwshPath = this.findExecutable('pwsh.exe');
    if (pwshPath) {
      return { path: pwshPath, name: 'pwsh', args: this.getShellArgs('pwsh') };
    }

    // Check for Windows PowerShell
    const powershellPath = this.findExecutable('powershell.exe');
    if (powershellPath) {
      return { path: powershellPath, name: 'powershell', args: this.getShellArgs('powershell') };
    }

    // Fall back to cmd.exe
    const cmdPath = path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe');
    if (fs.existsSync(cmdPath)) {
      return { path: cmdPath, name: 'cmd', args: this.getShellArgs('cmd') };
    }

    // Last resort
    return { path: 'cmd.exe', name: 'cmd', args: this.getShellArgs('cmd') };
  }

  static findGitBash(): string | null {
    const locations = [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      'C:\\Git\\bin\\bash.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
      path.join(os.homedir(), 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    ];

    // Check GIT_INSTALL_ROOT env var first
    const gitInstallRoot = process.env.GIT_INSTALL_ROOT || '';
    if (gitInstallRoot) {
      locations.unshift(path.join(gitInstallRoot, 'bin', 'bash.exe'));
    }

    for (const loc of locations) {
      try {
        if (loc && fs.existsSync(loc)) return loc;
      } catch {
        // Permission denied or other fs error, skip this location
      }
    }

    // No PATH fallback - bash.exe in PATH could be WSL launcher (C:\Windows\System32\bash.exe)
    // which is not Git Bash. Users with non-standard Git installs can set GIT_INSTALL_ROOT.
    return null;
  }

  private static detectUnixShell(): ShellInfo {
    // First, try the SHELL environment variable
    const envShell = process.env.SHELL;
    if (envShell && fs.existsSync(envShell)) {
      const name = path.basename(envShell);
      return { path: envShell, name, args: this.getShellArgs(name) };
    }

    // On macOS, try to get the default shell from Directory Services
    if (process.platform === 'darwin') {
      try {
        const username = os.userInfo().username;
        const result = execSync(`dscl . -read /Users/${username} UserShell`, { encoding: 'utf8' });
        const match = result.match(/UserShell:\s*(.+)/);
        if (match && match[1]) {
          const shellPath = match[1].trim();
          if (fs.existsSync(shellPath)) {
            const name = path.basename(shellPath);
            return { path: shellPath, name, args: this.getShellArgs(name) };
          }
        }
      } catch {
        // Ignore errors and continue with fallback detection
      }
    }

    // Try to read from /etc/passwd
    try {
      const username = os.userInfo().username;
      const passwdContent = fs.readFileSync('/etc/passwd', 'utf8');
      const userLine = passwdContent.split('\n').find(line => line.startsWith(`${username}:`));
      if (userLine) {
        const parts = userLine.split(':');
        const shellPath = parts[6];
        if (shellPath && fs.existsSync(shellPath)) {
          const name = path.basename(shellPath);
          return { path: shellPath, name, args: this.getShellArgs(name) };
        }
      }
    } catch {
      // Ignore errors and continue with fallback detection
    }

    // Try common shell paths in order of preference
    const commonShells = [
      '/usr/local/bin/zsh',
      '/bin/zsh',
      '/usr/bin/zsh',
      '/usr/local/bin/fish',
      '/usr/bin/fish',
      '/usr/local/bin/bash',
      '/bin/bash',
      '/usr/bin/bash',
      '/bin/sh',
      '/usr/bin/sh'
    ];

    for (const shellPath of commonShells) {
      if (fs.existsSync(shellPath)) {
        const name = path.basename(shellPath);
        return { path: shellPath, name, args: this.getShellArgs(name) };
      }
    }

    // Last resort - use sh
    return { path: '/bin/sh', name: 'sh', args: ['-i'] };
  }

  private static findExecutable(name: string): string | null {
    const pathEnv = process.env.PATH || '';
    const pathDirs = pathEnv.split(path.delimiter);

    for (const dir of pathDirs) {
      const fullPath = path.join(dir, name);
      if (fs.existsSync(fullPath)) {
        try {
          fs.accessSync(fullPath, fs.constants.X_OK);
          return fullPath;
        } catch {
          // Not executable, continue searching
        }
      }
    }

    return null;
  }

  private static getShellArgs(shellName: string): string[] {
    // Return appropriate arguments for interactive shell sessions
    switch (shellName) {
      case 'bash':
      case 'sh':
      case 'zsh':
      case 'fish':
      case 'gitbash':
        return ['-i']; // Interactive mode
      case 'pwsh':
      case 'powershell':
        return ['-NoExit']; // Keep PowerShell open
      default:
        return [];
    }
  }

  /**
   * Get shell-specific command execution arguments
   * @param command The command to execute
   * @returns Array of arguments to pass to spawn/exec
   */
  static getShellCommandArgs(command: string, preferredShell?: string): ShellCommand {
    const shellInfo = this.getDefaultShell(preferredShell);

    switch (shellInfo.name) {
      case 'cmd':
        return { shell: shellInfo.path, args: ['/c', command] };
      case 'powershell':
      case 'pwsh':
        return { shell: shellInfo.path, args: ['-Command', command] };
      case 'gitbash':
        return { shell: shellInfo.path, args: ['-c', command] };
      default:
        // Unix shells
        return { shell: shellInfo.path, args: ['-c', command] };
    }
  }

  /**
   * Get a list of available shells on Windows
   * @returns Array of available shells with id, name, and path
   */
  static getAvailableShells(): Array<{ id: string; name: string; path: string }> {
    if (process.platform !== 'win32') return [];

    const shells: Array<{ id: string; name: string; path: string }> = [];

    const gitBash = this.findGitBash();
    if (gitBash) shells.push({ id: 'gitbash', name: 'Git Bash', path: gitBash });

    const pwsh = this.findExecutable('pwsh.exe');
    if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell Core', path: pwsh });

    const powershell = this.findExecutable('powershell.exe');
    if (powershell) shells.push({ id: 'powershell', name: 'Windows PowerShell', path: powershell });

    const cmdPath = path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe');
    try {
      if (fs.existsSync(cmdPath)) shells.push({ id: 'cmd', name: 'Command Prompt', path: cmdPath });
    } catch { /* ignore */ }

    return shells;
  }

  /**
   * Get shell by preference ID
   * @param preference Shell preference ID ('gitbash', 'powershell', 'pwsh', 'cmd')
   * @returns ShellInfo if found, null otherwise
   */
  static getShellByPreference(preference: string): ShellInfo | null {
    if (process.platform !== 'win32') return null;

    switch (preference) {
      case 'gitbash': {
        const gitBash = this.findGitBash();
        return gitBash ? { path: gitBash, name: 'gitbash', args: this.getShellArgs('gitbash') } : null;
      }
      case 'pwsh': {
        const pwsh = this.findExecutable('pwsh.exe');
        return pwsh ? { path: pwsh, name: 'pwsh', args: this.getShellArgs('pwsh') } : null;
      }
      case 'powershell': {
        const powershell = this.findExecutable('powershell.exe');
        return powershell ? { path: powershell, name: 'powershell', args: this.getShellArgs('powershell') } : null;
      }
      case 'cmd': {
        const cmdPath = path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe');
        try {
          if (fs.existsSync(cmdPath)) {
            return { path: cmdPath, name: 'cmd', args: this.getShellArgs('cmd') };
          }
        } catch { /* ignore */ }
        return null;
      }
      default:
        return null;
    }
  }
}
