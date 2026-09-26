/**
 * Platform detection utilities.
 * Centralized helpers for detecting OS and getting platform-specific values.
 */

/**
 * Check if the current platform is macOS.
 */
export function isMac(): boolean {
  return navigator.platform.toUpperCase().includes('MAC');
}

/**
 * Check if the current platform is Windows.
 */
export function isWindows(): boolean {
  return navigator.platform.toLowerCase().includes('win');
}

/**
 * Get the modifier key name for the current platform.
 * Returns "Cmd" on macOS, "Ctrl" on other platforms.
 */
export function getModifierKeyName(): string {
  return isMac() ? 'Cmd' : 'Ctrl';
}

/**
 * Platform id in the form the shared shortcut catalog and agent presets use.
 * Project environments (e.g. WSL) can override this per project.
 */
export function rendererPlatform(): 'darwin' | 'win32' | 'linux' {
  return isWindows() ? 'win32' : isMac() ? 'darwin' : 'linux';
}
