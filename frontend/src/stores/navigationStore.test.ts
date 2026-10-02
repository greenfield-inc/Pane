import { afterEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

async function loadNavigationStore() {
  vi.resetModules();
  vi.stubGlobal('localStorage', new MemoryStorage());
  return import('./navigationStore');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('navigationStore project expansion', () => {
  it('does not auto-expand the initial project list', async () => {
    const { useNavigationStore } = await loadNavigationStore();

    const expandedProjectIds = useNavigationStore.getState().registerProjectIds([1, 2]);

    expect(expandedProjectIds).toBeNull();
    expect(Array.from(useNavigationStore.getState().expandedProjects)).toEqual([]);
  });

  it('hydrates persisted expansion and only auto-expands later project additions', async () => {
    const { useNavigationStore } = await loadNavigationStore();

    useNavigationStore.getState().hydrateExpandedProjects([2]);
    expect(useNavigationStore.getState().registerProjectIds([1, 2])).toBeNull();

    const expandedProjectIds = useNavigationStore.getState().registerProjectIds([1, 2, 3]);

    expect(expandedProjectIds).toEqual([2, 3]);
    expect(Array.from(useNavigationStore.getState().expandedProjects).sort()).toEqual([2, 3]);
  });

  it('returns the persisted shape after user project toggles', async () => {
    const { useNavigationStore } = await loadNavigationStore();

    useNavigationStore.getState().hydrateExpandedProjects([3]);

    expect(useNavigationStore.getState().toggleProjectExpanded(1)).toEqual([1, 3]);
    expect(useNavigationStore.getState().toggleProjectExpanded(3)).toEqual([1]);
  });

  it('adopts the new host expansion after a host switch without auto-expanding its repositories', async () => {
    const { useNavigationStore } = await loadNavigationStore();
    useNavigationStore.getState().hydrateExpandedProjects([1]);
    useNavigationStore.getState().registerProjectIds([1, 2]);

    useNavigationStore.getState().resetExpandedProjectsForHost([7]);

    expect(useNavigationStore.getState().registerProjectIds([5, 6, 7])).toBeNull();
    expect(Array.from(useNavigationStore.getState().expandedProjects)).toEqual([7]);
    expect(useNavigationStore.getState().registerProjectIds([5, 6, 7, 8])).toEqual([7, 8]);
  });
});
