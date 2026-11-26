import { describe, expect, it } from 'vitest';

import { createDispatcher } from './dispatcher';

type Action = 'controller-back' | 'send-draft';

describe('createDispatcher', () => {
  it('asks the newest scope first', () => {
    const dispatcher = createDispatcher<'home' | 'sheet', Action, null>();
    const calls: string[] = [];
    dispatcher.register({ context: 'home', handlers: { 'controller-back': () => void calls.push('home') } });
    dispatcher.register({ context: 'sheet', handlers: { 'controller-back': () => void calls.push('sheet') } });
    expect(dispatcher.dispatch('controller-back', null)).toBe(true);
    expect(calls).toEqual(['sheet']);
    expect(dispatcher.context('home')).toBe('sheet');
  });

  it('passes an action on when the handler returns false', () => {
    const dispatcher = createDispatcher<'home' | 'sheet', Action, null>();
    const calls: string[] = [];
    dispatcher.register({ context: 'home', handlers: { 'send-draft': () => void calls.push('home') } });
    dispatcher.register({ context: 'sheet', handlers: { 'send-draft': () => false } });
    dispatcher.dispatch('send-draft', null);
    expect(calls).toEqual(['home']);
  });

  it('forgets a removed scope and reports unhandled actions', () => {
    const dispatcher = createDispatcher<'home' | 'sheet', Action, null>();
    const remove = dispatcher.register({ context: 'sheet', handlers: { 'controller-back': () => true } });
    remove();
    expect(dispatcher.dispatch('controller-back', null)).toBe(false);
    expect(dispatcher.context('home')).toBe('home');
  });
});
