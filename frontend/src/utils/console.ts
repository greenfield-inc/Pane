import { useConfigStore } from '../stores/configStore';

// Read the current persisted setting at each call so Settings takes effect immediately.
const isLoggingEnabled = () => process.env.NODE_ENV === 'development' || useConfigStore.getState().config?.verbose === true;

export const devLog = {
  log: (...args: unknown[]) => {
    if (isLoggingEnabled()) {
      // eslint-disable-next-line no-console -- this module is the centralized console adapter.
      console.log(...args);
    }
  },
  
  warn: (...args: unknown[]) => {
    if (isLoggingEnabled()) {
      console.warn(...args);
    }
  },
  
  error: (...args: unknown[]) => {
    // Always log errors
    console.error(...args);
  },
  
  debug: (...args: unknown[]) => {
    if (isLoggingEnabled()) {
      // eslint-disable-next-line no-console -- this module is the centralized console adapter.
      console.debug(...args);
    }
  },
  
  info: (...args: unknown[]) => {
    if (isLoggingEnabled()) {
      // eslint-disable-next-line no-console -- this module is the centralized console adapter.
      console.info(...args);
    }
  }
};

/**
 * Performance-focused logging for component renders
 * Uses the same development/verbose gate as other optional diagnostics
 */
export const renderLog = (...args: unknown[]) => {
  if (isLoggingEnabled()) {
    // eslint-disable-next-line no-console -- this module is the centralized console adapter.
    console.log(...args);
  }
};
