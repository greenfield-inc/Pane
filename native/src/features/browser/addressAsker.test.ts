import { describe, expect, it } from 'vitest';

import { AddressAsker, type AddressFailure } from './addressAsker';

function setup(answers: Array<() => Promise<unknown>>) {
  const sent: number[] = [];
  const failures: Array<AddressFailure | null> = [];
  const asker = new AddressAsker(port => {
    sent.push(port);
    return (answers.shift() ?? (() => Promise.resolve()))();
  }, failure => failures.push(failure));
  return { asker, sent, failures };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('AddressAsker', () => {
  it('asks once per port', async () => {
    const { asker, sent } = setup([]);
    asker.ask(5173);
    asker.ask(5173);
    asker.ask(3000);
    await settle();
    expect(sent).toEqual([5173, 3000]);
  });

  it('reports a failed ask instead of waiting forever, and does not send it again on its own', async () => {
    const offline = new Error('The action was not sent while the workspace is disconnected or restoring.');
    const { asker, sent, failures } = setup([() => Promise.reject(offline)]);
    asker.ask(5173);
    await settle();
    asker.ask(5173);
    await settle();
    expect(sent).toEqual([5173]);
    expect(failures).toEqual([{ port: 5173, error: offline }]);
  });

  it('sends the ask again when the person tries again, clearing the failure', async () => {
    const { asker, sent, failures } = setup([() => Promise.reject(new Error('offline'))]);
    asker.ask(5173);
    await settle();
    asker.retry(5173);
    await settle();
    expect(sent).toEqual([5173, 5173]);
    expect(failures.at(-1)).toBeNull();
  });
});
