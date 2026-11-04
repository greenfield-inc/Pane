import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentChatPermissions } from './AgentChatPermissions';

it('renders only the provider permission choices with their exact scope labels', () => {
  const markup = renderToStaticMarkup(<AgentChatPermissions permissions={[{
    id: '4:permission', generation: 4, title: 'Write app.ts', toolCall: { path: 'app.ts' }, options: [
      { optionId: 'one', kind: 'allow_once', name: 'Allow this edit once' },
      { optionId: 'deny', kind: 'reject_once', name: 'Reject this edit' },
    ],
  }]} disabled={false} onAnswer={async () => undefined} />);
  expect(markup).toContain('Allow this edit once');
  expect(markup).toContain('Reject this edit');
  expect(markup).not.toContain('Always allow');
});
