import { describe, expect, it } from 'vitest';

import { invokeChannel } from './invoke';

function clientReturning(result: unknown) {
  return { invoke: async () => result };
}

describe('invokeChannel', () => {
  it('unwraps an IPC-style { success, data } result', async () => {
    const projects = [{ id: 1, name: 'Pane' }];
    await expect(invokeChannel(clientReturning({ success: true, data: projects }), 'sessions:get-all-with-projects'))
      .resolves.toEqual(projects);
  });

  it('turns an IPC-style failure into an error with the host message', async () => {
    await expect(invokeChannel(clientReturning({ success: false, error: 'Session not found' }), 'sessions:get', ['x']))
      .rejects.toThrow('Session not found');
  });

  it('passes plain results through', async () => {
    await expect(invokeChannel(clientReturning(['main', 'dev']), 'projects:list-branches')).resolves.toEqual(['main', 'dev']);
    await expect(invokeChannel(clientReturning(null), 'panels:getActive')).resolves.toBeNull();
  });

  it('preserves domain data and errors without a boolean IPC envelope marker', async () => {
    const view = { panelId: 'chat-a', error: 'Provider authentication expired', running: false };
    await expect(invokeChannel(clientReturning(view), 'agent-chat:get', ['chat-a'])).resolves.toEqual(view);
    const receipt = { operationId: 'send-a', state: 'failed', error: 'Rejected prompt' };
    await expect(invokeChannel(clientReturning(receipt), 'agent-chat:receipt', ['chat-a', 'send-a'])).resolves.toEqual(receipt);
  });
});
