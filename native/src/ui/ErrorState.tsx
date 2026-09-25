import { useTheme } from '@/theme';

import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';

export interface ErrorStateProps {
  title?: string;
  error: unknown;
  onRetry?: () => void;
  testID?: string;
}

export function ErrorState({ title = 'Something went wrong', error, onRetry, testID }: ErrorStateProps) {
  const theme = useTheme();
  return (
    <EmptyState
      testID={testID}
      icon={<Icon ios="exclamationmark.triangle" android="warning" size={36} color={theme.colors.warning} />}
      title={title}
      message={error instanceof Error ? error.message : String(error)}
      action={onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : undefined}
    />
  );
}
