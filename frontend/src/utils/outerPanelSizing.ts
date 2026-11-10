import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

export type OuterPanelSurface =
  | 'worktreeInspector'
  | 'projectInspector'
  | 'bottomTerminal'
  | 'rightTerminal'
  | 'bottomDetail'
  | 'approvalsList'
  | 'autopilotChat';

export interface OuterPanelBounds {
  floor: number;
  cap: number;
}

export interface OuterPanelSize extends OuterPanelBounds {
  effectivePx: number;
}

export interface OuterPanelConfig {
  axis: 'width' | 'height';
  /**
   * Which edge of its container the panel sits on. 'end' (the default) is a right or bottom
   * panel: dragging its separator toward the start grows it. 'start' is a left panel: dragging
   * right grows it.
   */
  edge?: 'start' | 'end';
  storageKey: string;
  legacyKey: string;
  legacyMin: number;
  legacyMax: number;
  legacyDefault: number;
  defaultPx: (containerPx: number) => number;
  bounds: (containerPx: number) => OuterPanelBounds;
}

const widthBounds = (maximum: number, minimum: number) => (containerPx: number): OuterPanelBounds => {
  const width = normalizeContainer(containerPx);
  const rawCap = Math.max(0, Math.min(maximum, width - 320));
  const cap = rawCap >= 96 ? rawCap : 0;
  return { floor: Math.min(minimum, cap), cap };
};

const bottomBounds = (maximum: number | undefined, minimum: number) => (containerPx: number): OuterPanelBounds => {
  const height = normalizeContainer(containerPx);
  const rawCap = Math.max(0, Math.min(maximum ?? height, height, Math.max(32, height - 160)));
  const cap = rawCap >= 64 ? rawCap : Math.min(32, height);
  return { floor: cap >= 64 ? Math.min(minimum, cap) : cap, cap };
};

/**
 * One side of a two-column split: at least `minimum`, leaving at least `reserve` for the other
 * side. Too narrow for both, the cap is 0 (unusable), so the view keeps its own narrow layout.
 */
const splitBounds = (minimum: number, reserve: number, maximum: number) => (containerPx: number): OuterPanelBounds => {
  const rawCap = Math.min(maximum, normalizeContainer(containerPx) - reserve);
  const cap = rawCap >= minimum ? rawCap : 0;
  return { floor: Math.min(minimum, cap), cap };
};

export const OUTER_PANEL_CONFIGS = {
  worktreeInspector: {
    axis: 'width',
    storageKey: 'pane-detail-panel-width:v2',
    legacyKey: 'pane-detail-panel-width',
    legacyMin: 240,
    legacyMax: 720,
    legacyDefault: 360,
    defaultPx: () => 360,
    bounds: widthBounds(720, 240),
  },
  projectInspector: {
    axis: 'width',
    storageKey: 'pane-project-detail-panel-width:v2',
    legacyKey: 'pane-project-detail-panel-width',
    legacyMin: 240,
    legacyMax: 720,
    legacyDefault: 360,
    defaultPx: () => 360,
    bounds: widthBounds(720, 240),
  },
  bottomTerminal: {
    axis: 'height',
    storageKey: 'pane-bottom-terminal-height:v2',
    legacyKey: 'pane-bottom-terminal-height',
    legacyMin: 100,
    legacyMax: 500,
    legacyDefault: 200,
    defaultPx: (height) => Math.round(height * 0.32),
    bounds: bottomBounds(undefined, 100),
  },
  rightTerminal: {
    axis: 'width',
    storageKey: 'pane-right-terminal-width:v2',
    legacyKey: 'pane-right-terminal-width',
    legacyMin: 200,
    legacyMax: 600,
    legacyDefault: 350,
    defaultPx: () => 350,
    bounds: widthBounds(600, 200),
  },
  bottomDetail: {
    axis: 'height',
    storageKey: 'pane-bottom-detail-height:v2',
    legacyKey: 'pane-bottom-detail-height',
    legacyMin: 80,
    legacyMax: 400,
    legacyDefault: 200,
    defaultPx: () => 200,
    bounds: bottomBounds(400, 80),
  },
  // Approvals: the list on the left, the Session beside it taking the rest.
  approvalsList: {
    axis: 'width',
    edge: 'start',
    storageKey: 'pane-approvals-list-width:v2',
    legacyKey: 'pane-approvals-list-width',
    legacyMin: 260,
    legacyMax: 1200,
    legacyDefault: 400,
    defaultPx: () => 400,
    bounds: splitBounds(260, 360, 1200),
  },
  // Autopilot: its chat on the left, the stack on the right taking the rest.
  autopilotChat: {
    axis: 'width',
    edge: 'start',
    storageKey: 'pane-autopilot-chat-width:v2',
    legacyKey: 'pane-autopilot-chat-width',
    legacyMin: 380,
    legacyMax: 1600,
    legacyDefault: 560,
    defaultPx: (width) => clamp(Math.round(width * 0.44), 380, 720),
    bounds: splitBounds(380, 300, 1600),
  },
} satisfies Record<OuterPanelSurface, OuterPanelConfig>;

export function resolveOuterPanelSize(
  config: OuterPanelConfig,
  containerPx: number,
  preferredPx?: number,
): OuterPanelSize {
  const bounds = config.bounds(containerPx);
  const fallback = config.defaultPx(normalizeContainer(containerPx));
  const base = preferredPx ?? fallback;
  const effectivePx = clamp(Math.round(Number.isFinite(base) ? base : fallback), bounds.floor, bounds.cap);
  return { ...bounds, effectivePx };
}

export interface OuterPanelRenderPolicy {
  renderedPx: number;
  bodyActive: boolean;
  separatorVisible: boolean;
}

export function resolveOuterPanelRenderPolicy(
  config: OuterPanelConfig,
  size: OuterPanelSize,
  enabled: boolean,
): OuterPanelRenderPolicy {
  const usable = config.axis === 'width' ? size.cap > 0 : size.cap >= 64;
  return {
    renderedPx: enabled ? size.effectivePx : 0,
    bodyActive: enabled && usable,
    separatorVisible: enabled && usable && size.floor < size.cap,
  };
}

export function readOuterPanelPreference(config: OuterPanelConfig, storage: Storage): number | undefined {
  const storedV2 = storage.getItem(config.storageKey);
  if (storedV2 !== null) {
    try {
      const parsed = decodeOptionalBoundary(JSON.parse(storedV2), v2PreferenceSchema);
      if (parsed && Number.isInteger(parsed.preferredPx) && parsed.preferredPx >= 1 && parsed.preferredPx <= 8192) {
        return parsed.preferredPx;
      }
    } catch {
      // Invalid v2 values intentionally fall through to strict legacy migration.
    }
  }

  const legacy = storage.getItem(config.legacyKey);
  if (legacy === null || !/^(?:0|[1-9]\d*)$/.test(legacy)) return undefined;
  const value = Number(legacy);
  if (value < config.legacyMin || value > config.legacyMax || value === config.legacyDefault) return undefined;
  return value;
}

export function writeOuterPanelPreference(config: OuterPanelConfig, storage: Storage, preferredPx: number): void {
  const value = clamp(Math.round(preferredPx), 1, 8192);
  storage.setItem(config.storageKey, JSON.stringify({ version: 2, preferredPx: value }));
}

/** Forgets the remembered size (both keys), so the panel goes back to its default. */
export function clearOuterPanelPreference(config: OuterPanelConfig, storage: Storage): void {
  storage.removeItem(config.storageKey);
  storage.removeItem(config.legacyKey);
}

const v2PreferenceSchema = boundary.object({
  version: boundary.literal(2),
  preferredPx: boundary.number,
});

function normalizeContainer(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
