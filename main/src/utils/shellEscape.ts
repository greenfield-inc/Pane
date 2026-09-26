/**
 * Safely escape shell arguments to prevent command injection
 */

/**
 * Escape a string for safe use in shell commands
 * @param arg The argument to escape
 * @returns The escaped argument
 */
export function escapeShellArg(arg: string): string {
  // If the argument is empty, return empty quotes
  if (!arg) return "''";
  
  // For Windows, wrap in double quotes and escape internal quotes
  if (process.platform === 'win32') {
    // Escape existing double quotes and backslashes
    const escaped = arg
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  
  // For Unix-like systems, use single quotes and handle internal single quotes
  // by ending the quote, adding an escaped single quote, and starting a new quote
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
