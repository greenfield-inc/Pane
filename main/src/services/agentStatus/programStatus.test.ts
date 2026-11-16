import { describe, expect, it } from 'vitest';
import { ProgramStatusRecords } from './programStatus';

// Report bodies (the text between `OSC 7501 ;` and ST) are copied from the
// Program Status Protocol 0.4 examples at
// https://www.superlogical.com/rex/docs/build/program-status
const TERRAFORM_BLOCKED = 'state=blocked:kind=permission:app=terraform:msg=QXBwbHkgMyB0byBhZGQsIDEgdG8gY2hhbmdlLCAwIHRvIGRlc3Ryb3k/';
const BREW_WORKING = 'state=working:app=brew:msg=SW5zdGFsbGluZyB1cGRhdGVz';
const BREW_AUTH = 'state=blocked:kind=auth:app=brew:msg=UGFzc3dvcmQgcmVxdWlyZWQgdG8gaW5zdGFsbCB1cGRhdGVz';
const BREW_DONE = 'state=done:app=brew:msg=VXBncmFkZWQgMTIgcGFja2FnZXM=';

function recordsAfter(...bodies: string[]): ProgramStatusRecords {
  const records = new ProgramStatusRecords();
  for (const body of bodies) records.report(body);
  return records;
}

describe('ProgramStatusRecords', () => {
  it('reads the spec examples, base64 messages decoded', () => {
    expect(recordsAfter(TERRAFORM_BLOCKED).current()).toEqual({
      state: 'blocked', kind: 'permission', app: 'terraform', msg: 'Apply 3 to add, 1 to change, 0 to destroy?',
    });
    expect(recordsAfter(BREW_WORKING, BREW_AUTH).current()).toEqual({
      state: 'blocked', kind: 'auth', app: 'brew', msg: 'Password required to install updates',
    });
    expect(recordsAfter(BREW_WORKING, BREW_AUTH, BREW_WORKING, BREW_DONE).current()).toEqual({
      state: 'done', app: 'brew', msg: 'Upgraded 12 packages',
    });
  });

  it('reports nothing until a program reports', () => {
    expect(new ProgramStatusRecords().current()).toBeUndefined();
  });

  it('shows the most urgent record, with app inherited from the root', () => {
    const records = recordsAfter(
      'state=working:app=deploy:msg=RGVwbG95aW5nIHYyLjQuMQ==',
      'state=working:id=us-east:title=VVMgRWFzdA==:progress=40:msg=UHVzaGluZyBpbWFnZQ==',
      'state=blocked:kind=permission:id=eu-west:title=RVUgV2VzdA==:msg=QXBwcm92ZSBkZXBsb3kgdG8gZXUtd2VzdCAocHJvZHVjdGlvbik/',
    );
    expect(records.current()).toEqual({
      state: 'blocked', kind: 'permission', app: 'deploy', title: 'EU West', msg: 'Approve deploy to eu-west (production)?',
    });
    records.report('state=clear:id=eu-west');
    expect(records.current()).toEqual({ state: 'working', app: 'deploy', title: 'US East', msg: 'Pushing image' });
    records.report('state=clear');
    expect(records.current()).toBeUndefined();
  });

  it('clears a record and every record beneath it', () => {
    const records = recordsAfter('state=idle', 'state=blocked:id=build', 'state=working:id=build/test');
    records.report('state=clear:id=build');
    expect(records.current()).toEqual({ state: 'idle' });
  });

  it('replaces a record whole: keys missing from a report are gone', () => {
    expect(recordsAfter(BREW_AUTH, 'state=working').current()).toEqual({ state: 'working' });
  });

  it('ignores reports with no state, an unknown state, or a malformed id', () => {
    const records = recordsAfter(BREW_WORKING);
    for (const body of ['app=brew', 'state=paused', 'state=blocked:id=a//b', 'state=blocked:id=a,b', '', 'garbage']) {
      records.report(body);
    }
    expect(records.current()).toMatchObject({ state: 'working', app: 'brew' });
  });

  it('skips malformed pairs and treats bad optional values as absent', () => {
    expect(recordsAfter('state=blocked:kind=telepathy:app=bad!app:nonsense: =x:msg=SGk:extra=1').current())
      .toEqual({ state: 'blocked', msg: 'Hi' });
    expect(recordsAfter(' state = working : app = cargo ').current()).toEqual({ state: 'working', app: 'cargo' });
    expect(recordsAfter('state=working:state=done').current()).toEqual({ state: 'done' });
    expect(recordsAfter('state=working:kind=question').current()).toEqual({ state: 'working' });
  });

  it('discards a whole report whose text has a control character or fails to decode', () => {
    const records = recordsAfter(BREW_WORKING);
    // "line\nbreak", "\u0007bell", and base64 that is not valid UTF-8 or not base64 at all.
    for (const msg of ['bGluZQpicmVhaw==', 'B2JlbGw=', '/w==', 'A']) records.report(`state=blocked:msg=${msg}`);
    expect(records.current()).toMatchObject({ state: 'working', app: 'brew' });
  });

  it('discards a report that breaks a limit', () => {
    const records = recordsAfter(BREW_WORKING);
    records.report(`state=blocked:msg=${'QUFB'.repeat(700)}`); // 2800 encoded bytes > 2732
    records.report(`state=blocked:app=${'a'.repeat(33)}`);
    records.report(`state=blocked:${'k'.repeat(17)}=1`);
    records.report(`state=blocked:id=${Array.from({ length: 9 }, () => 'a').join('/')}`);
    expect(records.current()).toMatchObject({ state: 'working', app: 'brew' });
  });

  it('keeps at most 256 records, dropping the least recently updated', () => {
    const records = recordsAfter('state=blocked:id=first');
    for (let index = 0; index < 256; index += 1) records.report(`state=idle:id=r${index}`);
    expect(records.current()).toMatchObject({ state: 'idle' });
  });

  it('drops working, blocked and idle records when the program exits, keeping done and error', () => {
    const records = recordsAfter('state=error:id=lint', 'state=working', 'state=blocked:id=deploy');
    records.dropRunning();
    expect(records.current()).toEqual({ state: 'error' });
    records.dropFinished();
    expect(records.current()).toBeUndefined();
  });

  it('removes direction overrides and invisible formatting from shown text', () => {
    // "safe‮txt.exe​" base64-encoded.
    expect(recordsAfter('state=done:msg=c2FmZeKArnR4dC5leGXigIs=').current()).toEqual({ state: 'done', msg: 'safetxt.exe' });
  });
});
