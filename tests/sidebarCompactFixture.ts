// Shared helpers for sidebar-compact.spec.ts.
import { expect, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';

export const projects = [
  {
    id: 1,
    name: 'Alpha',
    path: '/tmp/alpha',
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    name: 'Beta',
    path: '/tmp/beta',
    active: false,
    created_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  },
];

export function session(
  id: string,
  name: string,
  projectId: number,
  overrides: JsonObject = {},
) {
  return {
    id,
    name,
    projectId,
    worktreePath: `/tmp/${id}`,
    prompt: '',
    status: 'stopped',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivity: '2026-01-01T00:00:00.000Z',
    output: [],
    jsonMessages: [],
    permissionMode: 'ignore',
    toolType: 'none',
    archived: false,
    isHidden: false,
    isFavorite: false,
    ...overrides,
  };
}

export async function collapseSidebar(page: Page) {
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  await expect(collapse).toBeVisible({ timeout: 10_000 });
  await collapse.click();
  await expect(page.getByRole('navigation', { name: 'Compact sidebar' })).toBeVisible();
}
