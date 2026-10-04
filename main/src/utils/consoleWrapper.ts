// Simple console wrapper to reduce logging in production
// This follows the existing pattern in the codebase
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { redactProcessOutput } from './deliveredSecrets';

const runtimeGlobal = decodeBoundary(global, boundary.object({
  isPackaged: boundary.optional(boundary.boolean),
}));
const isDevelopment = process.env.NODE_ENV !== 'production' && !runtimeGlobal.isPackaged;

// Store original console methods
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug
};

function writeOriginalConsole(method: (...args: unknown[]) => void, args: unknown[]): void {
  try {
    method(...args);
  } catch (error) {
    let code: string | undefined;
    try {
      code = decodeBoundary(error, boundary.object({ code: boundary.optional(boundary.string) })).code;
    } catch {
      code = undefined;
    }
    if (code !== 'EPIPE') {
      throw error;
    }
  }
}

// Helper to check if a message should be logged
function shouldLog(level: 'log' | 'info' | 'debug', args: unknown[]): boolean {
  if (args.length === 0) return false;
  const firstArg = args[0];
  let message: string | undefined;
  try {
    message = decodeBoundary(firstArg, boundary.string);
  } catch {
    message = undefined;
  }
  if (message !== undefined) {
    // Always log [Main] messages as they're important startup info
    if (message.includes('[Main]')) return true;
    // Always log errors from any component
    if (message.includes('Error') || message.includes('Failed')) return true;
    
    // Skip verbose logging from these components in both dev and production
    if (message.includes('[CommandExecutor]')) return false;
    if (message.includes('[ShellPath]')) return false;
    if (message.includes('[Database] Getting folders')) return false;
    if (message.includes('[WorktreeManager]') && message.includes('called with')) return false;
    // Skip git status polling logs
    if (message.includes('[GitStatus]') && !message.includes('error') && !message.includes('failed')) return false;
    if (message.includes('[Git]') && message.includes('Refreshing git status')) return false;
    // Skip individual git status updates from frontend
    if (message.includes('Git status updated:')) return false;
    if (message.includes('Git status:') && message.includes('→')) return false;
    // Skip verbose git status manager logs
    if (message.includes('Polling git status for')) return false;
    if (message.includes('Using cached status for')) return false;
    if (message.includes('[IPC:git] Getting commits')) return false;
    if (message.includes('[IPC:git] Project path:')) return false;
    if (message.includes('[IPC:git] Using main branch:')) return false;
    
    // In development, log everything else
    if (isDevelopment) {
      return true;
    }
  }
  
  return !isDevelopment; // In production, default to not logging
}

// Override console methods
export function setupConsoleWrapper() {
  redactProcessOutput();
  console.log = (...args: unknown[]) => {
    if (shouldLog('log', args)) {
      writeOriginalConsole(originalConsole.log, args);
    }
  };
  
  console.info = (...args: unknown[]) => {
    if (shouldLog('info', args)) {
      writeOriginalConsole(originalConsole.info, args);
    }
  };
  
  console.debug = (...args: unknown[]) => {
    if (shouldLog('debug', args)) {
      writeOriginalConsole(originalConsole.debug, args);
    }
  };
  
  // Always log warnings and errors
  console.warn = (...args: unknown[]) => {
    writeOriginalConsole(originalConsole.warn, args);
  };
  console.error = (...args: unknown[]) => {
    writeOriginalConsole(originalConsole.error, args);
  };
}

// Export original console for critical logging
export { originalConsole };
