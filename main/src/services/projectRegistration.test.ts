import { expect, it } from 'vitest';
import { resolveProjectRegistration, projectRegistrationKey } from './projectRegistration';

it('uses the distro and Linux path for WSL storage and command execution', () => {
  const registration = resolveProjectRegistration('\\\\wsl$\\Ubuntu\\home\\user\\repo');
  expect(registration).toMatchObject({
    path: '/home/user/repo',
    wsl_enabled: true,
    wsl_distribution: 'Ubuntu',
    pathResolver: { environment: 'wsl' },
    commandRunner: { wslContext: { distribution: 'Ubuntu', linuxPath: '/home/user/repo' } },
  });
  expect(projectRegistrationKey(registration)).not.toBe(projectRegistrationKey({ path: '/home/user/repo' }));
  expect(projectRegistrationKey(registration)).not.toBe(projectRegistrationKey({
    path: '/home/user/repo', wsl_enabled: true, wsl_distribution: 'Debian',
  }));
});
