import type { ErrorBoundaryProps } from 'expo-router';

import { ErrorState, Screen } from '@/ui';

/** Shown instead of a route that threw while rendering. */
export function RouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <Screen edges={['top', 'bottom']}>
      <ErrorState error={error} onRetry={() => void retry()} />
    </Screen>
  );
}
