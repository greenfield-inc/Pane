import { useConfigStore } from '../stores/configStore';

// Read the current persisted setting at each call so Settings takes effect immediately.
const isVerboseEnabled = () => useConfigStore.getState().config?.verbose === true;
const isLoggingEnabled = () => process.env.NODE_ENV === 'development' || isVerboseEnabled();

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
    if (isVerboseEnabled()) {
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
 * Only logs with verbose enabled, so development builds stay quiet by default
 */
export const renderLog = (...args: unknown[]) => {
  if (isVerboseEnabled()) {
    // eslint-disable-next-line no-console -- this module is the centralized console adapter.
    console.log(...args);
  }
};
