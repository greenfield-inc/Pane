import { expect, it } from 'vitest';
import { resolveTerminalPath } from './resolveTerminalPath';

it.each([
  ['./src/../app.ts:12:3', '/repo', undefined, '/repo/app.ts', 'app.ts'],
  ['/repo-two/app.ts', '/repo', undefined, '/repo-two/app.ts', null],
  ['../private.txt', '/repo', undefined, '/private.txt', null],
  ['~/.zshrc', '/repo', '/Users/dev', '/Users/dev/.zshrc', null],
  ['~/repo/app.ts', '/Users/dev/repo', '/Users/dev', '/Users/dev/repo/app.ts', 'app.ts'],
  ['~/.zshrc', '/repo', undefined, null, null],
  ['C:\\repo\\src\\app.ts:2', 'C:\\repo', undefined, 'C:\\repo\\src\\app.ts', 'src/app.ts'],
  ['/home/dev/repo/app.ts', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', undefined, '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo\\app.ts', 'app.ts'],
  ['~/.zshrc', '\\\\wsl.localhost\\Ubuntu\\repo', '\\\\wsl.localhost\\Ubuntu\\home\\dev', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.zshrc', null],
])('resolves %s in %s', (input, cwd, home, absolutePath, relativePath) => {
  expect(resolveTerminalPath(input, cwd, home)).toEqual({ absolutePath, relativePath });
});
