import { router } from 'expo-router';

import { Button, Sheet, Text } from '@/ui';

// PLACEHOLDER: the create-pane feature (repo, branch, agent) lands here.
export default function NewPaneSheet() {
  return (
    <Sheet title="New pane" footer={<Button title="Close" variant="secondary" onPress={() => router.back()} />}>
      <Text tone="muted">Pick a repository, branch and agent.</Text>
    </Sheet>
  );
}
