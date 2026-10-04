import { useCallback, useEffect, useState } from 'react';
import { API } from '../utils/api';
import { isDeviceLoginActive, nextDeviceLoginState } from '../utils/githubDeviceLogin';
import type { GitHubDeviceLoginStartRequest, GitHubDeviceLoginState } from '../../../shared/types/githubDeviceLogin';

const POLL_INTERVAL_MS = 1000;
const IDLE: GitHubDeviceLoginState = { status: 'idle' };

/**
 * Drives gh's device sign-in on the active host while `enabled`: start, poll
 * until it finishes, cancel. The state carries the one-time code while
 * waiting, so it is only rendered, never logged.
 */
export function useGitHubDeviceLogin(enabled: boolean) {
  const [state, setState] = useState<GitHubDeviceLoginState>(IDLE);
  const [requestError, setRequestError] = useState('');
  const active = isDeviceLoginActive(state);

  const apply = useCallback((incoming: GitHubDeviceLoginState) => {
    setState((current) => nextDeviceLoginState(current, incoming));
  }, []);

  // Pick up a sign-in still running on the host, e.g. after the dialog was reopened.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void API.githubDeviceLogin.status()
      .then((response) => {
        if (!cancelled && response.success && response.data) apply(response.data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, apply]);

  useEffect(() => {
    if (!enabled || !active) return;
    const timer = window.setInterval(() => {
      void API.githubDeviceLogin.status()
        .then((response) => {
          if (response.success && response.data) apply(response.data);
        })
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, active, apply]);

  const start = useCallback(async (request: GitHubDeviceLoginStartRequest) => {
    setRequestError('');
    try {
      const response = await API.githubDeviceLogin.start(request);
      if (!response.success || !response.data) {
        setRequestError(response.error ?? 'Could not start signing in to GitHub.');
        return;
      }
      // A fresh start replaces whatever finished before it.
      const started = response.data;
      setState((current) => (current.status === 'idle' || !isDeviceLoginActive(current) ? started : nextDeviceLoginState(current, started)));
    } catch {
      setRequestError('Could not start signing in to GitHub.');
    }
  }, []);

  const cancel = useCallback(async () => {
    try {
      const response = await API.githubDeviceLogin.cancel();
      if (response.success && response.data) apply(response.data);
    } catch {
      setRequestError('Could not cancel signing in to GitHub.');
    }
  }, [apply]);

  return { state, requestError, start, cancel };
}
