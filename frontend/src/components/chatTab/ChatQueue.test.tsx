import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatTabQueuedPrompt } from '../../../../shared/types/chatTab';
import { ChatQueue, type ChatQueueProps } from './ChatQueue';
import { isClearCommand, matchingCommands, withPaneCommands } from './chatCommands';

const item = (operationId: string, text: string, extra: Partial<ChatTabQueuedPrompt> = {}): ChatTabQueuedPrompt => ({ operationId, text, queuedAt: '2026-11-08T10:00:00.000Z', ...extra });
const render = (props: Partial<ChatQueueProps>) => renderToStaticMarkup(<ChatQueue queue={[]} working={false} disabled={false}
  onRemove={() => undefined} onSendNow={() => undefined} onEdit={async () => true} {...props} />);
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('ChatQueue', () => {
  it('lists queued messages in order, each with Send now while a turn runs', () => {
    const markup = render({ working: true, queue: [item('a', 'first'), item('b', 'second')] });
    expect(text(markup)).toBe('first Sends next Send now second Queued Send now');
    expect(markup.match(/aria-label="Edit queued message"/g)).toHaveLength(2);
    expect(markup.match(/aria-label="Remove from queue"/g)).toHaveLength(2);
  });

  it('offers no Send now when idle, and no edit for a preview cut short or a labelled line', () => {
    const markup = render({ queue: [item('a', 'x'.repeat(500)), item('b', '[Pane · Sentinel check] …')], label: value => value.startsWith('[Pane') ? 'Sentinel check' : undefined });
    expect(markup).not.toContain('Send now');
    expect(markup).not.toContain('aria-label="Edit queued message"');
    expect(text(markup)).toContain('Sentinel check');
  });

  it('renders nothing with an empty queue', () => {
    expect(render({})).toBe('');
  });
});

describe('/clear', () => {
  it("is Pane's own command, listed first and replacing the agent's", () => {
    const commands = withPaneCommands([{ name: 'clear', description: 'agent clear' }, { name: 'compact' }]);
    expect(commands.map(command => command.description ?? command.name)).toEqual(['Start a fresh conversation in this tab', 'compact']);
    expect(matchingCommands('/cl', commands).map(command => command.name)).toEqual(['clear']);
  });

  it('matches only the command alone', () => {
    expect(isClearCommand(' /clear ')).toBe(true);
    expect(isClearCommand('/clear the cache')).toBe(false);
  });
});
