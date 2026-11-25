import { describe, expect, it } from 'vitest';
import { agentContent } from './skillDispatch';

const commands = [{ name: 'compact' }, { name: 'simplify', skill: true as const }, { name: 'audit', skill: true as const }, { name: 'plugin:ship', skill: true as const }];
const parts = (text: string) => agentContent({ text }, commands, 'meta').map(block => block.type === 'text' ? block.text : block.type);

describe('what Claude is sent for a message that names a skill', () => {
  it.each([
    ['$simplify', ['/simplify']],
    ['  $simplify the diff', ['/simplify the diff']],
    ['Fix this, then $simplify', ['Fix this, then', '/simplify']],
    ['Fix this, then $simplify the rest\nand test', ['Fix this, then', '/simplify the rest\nand test']],
    ['Run $audit first, then $simplify it', ['Run /audit first, then', '/simplify it']],
    ['$audit first, then $simplify it', ['$audit first, then', '/simplify it']],
    ['Do $simplify a, then $simplify b', ['Do /simplify a, then', '/simplify b']],
    ['Please use $simplify.', ['Please use', '/simplify .']],
    ['Now $plugin:ship: fast', ['Now', '/plugin:ship : fast']],
    ['/tmp/build is old. Then $simplify', ['/tmp/build is old. Then', '/simplify']],
  ])('%j runs its last skill', (text, expected) => expect(parts(text)).toEqual(expected));

  it.each([
    'Fix the build', 'It costs $5 and $10k', 'echo $HOME then $unknown', 'x$simplify', '$simplify-all', '$Simplify',
    'look in /simplify', 'Say `$simplify`', '```\n$simplify\n```', 'Before\n\n```sh\n$simplify',
    '/compact keep $simplify', '/simplify then $audit',
  ])('%j is sent as typed', text => expect(parts(text)).toEqual([text]));

  it('puts images before the skill, which Claude runs only as the last part', () => {
    const content = agentContent({ text: 'What is this? $simplify', images: [{ mimeType: 'image/png', data: 'AA==' }] }, commands, 'meta');
    expect(content.map(block => block.type === 'text' ? block.text : block.type)).toEqual(['image', 'What is this?', '/simplify']);
  });

  it('leaves the text to an agent that reads $name itself', () => {
    expect(agentContent({ text: 'Then $simplify' }, [{ name: '$simplify', skill: true }], 'dollar')).toEqual([{ type: 'text', text: 'Then $simplify' }]);
  });
});
