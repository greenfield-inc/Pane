import { vi } from 'vitest';
import type { panelManager as realPanelManager } from '../services/panelManager';

// Passed explicitly to the manager under test; other suites use real services.
export const panelManager = {
  emitPanelEvent: vi.fn<typeof realPanelManager.emitPanelEvent>(),
  getPanel: vi.fn<typeof realPanelManager.getPanel>(),
  updatePanel: vi.fn<typeof realPanelManager.updatePanel>().mockResolvedValue(undefined),
};
