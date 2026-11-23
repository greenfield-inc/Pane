import { create } from 'zustand';
import type { LinkPreview, LinkRedeemResult, RelayLinkOpenedEvent, RelayPairedEvent, RelayPairingInfo, RelayStatus } from '../../../../shared/types/relay';
import { RELAY_DEVICE_COMMANDS } from '../../../../shared/types/relay';
import type { ComputerRoutesReport } from '../../../../shared/types/remoteComputers';
import { parseRelayPairingLink } from '../../../../shared/remoteClient/relay';
import { ipcErrorCode, ipcErrorMessage } from '../../utils/ipcErrorMessage';

export type AddDeviceTab = 'phone' | 'computer' | 'ssh' | 'wearables';

/** How long a link copied from the Computer tab works. */
export type LinkExpiry = '10m' | '1h' | '24h';

export const LINK_EXPIRY_LABELS = { '10m': '10 minutes', '1h': '1 hour', '24h': '24 hours' } satisfies Record<LinkExpiry, string>;

/** Where a link came from: pasted into the Computer tab, or opened from a `pane://pair` link (the full-page confirm). */
export type LinkSource = 'paste' | 'opened';

/** One link on its way from preview to redeemed. */
export type LinkFlow =
  | { step: 'idle' }
  | { step: 'checking'; source: LinkSource }
  | { step: 'confirm'; source: LinkSource; link: string; preview: LinkPreview; here: string }
  | { step: 'linking'; source: LinkSource; maker: string }
  | { step: 'linked'; source: LinkSource; maker: string; linked: string[]; turnedOnPhoneAccess: boolean }
  | { step: 'failed'; source: LinkSource; message: string };

/** The computer that used this dialog's link, and what came of "Not you? Unlink". */
export interface MakerResult {
  label: string;
  computerId?: string;
  unlink: 'idle' | 'busy' | 'done';
  /** What "Not you? Unlink" did. */
  outcome?: string;
}

interface AddDeviceState {
  isOpen: boolean;
  tab: AddDeviceTab;
  /** The computer an "Add route" or "Link" button named. */
  computerId: string | null;
  open: (tab: AddDeviceTab, options?: { computerId?: string }) => void;
  close: () => void;
  setTab: (tab: AddDeviceTab) => void;

  expiresIn: LinkExpiry;
  setExpiresIn: (expiresIn: LinkExpiry) => void;
  /** The last link copied from the Computer tab. */
  copied: RelayPairingInfo | null;
  copyError: string | null;
  copyLink: () => Promise<void>;

  flow: LinkFlow;
  /** Previews a pasted or opened link; links at once when nothing here would join a second group. */
  startLink: (link: string, source: LinkSource) => Promise<void>;
  /** "Link" on the confirm. */
  confirmLink: () => Promise<void>;
  /** "Not mine, cancel": nothing is redeemed, so the link stays usable. */
  cancelLink: () => void;

  maker: MakerResult | null;
  unlinkMaker: () => Promise<void>;
}

// Bumped for every new link and on cancel, so a late answer never lands on a newer flow.
let flowGeneration = 0;
/** Set once this app has copied a link; only then is a computer's `relay:paired` this dialog's result. */
let copiedALink = false;

const IDLE: LinkFlow = { step: 'idle' };

function refusal(cause: unknown, fallback: string): string {
  const code = ipcErrorCode(cause);
  if (code === 'ERR_PAIRING_CODE_USED') return 'This code was already used';
  if (code === 'ERR_PAIRING_CODE_EXPIRED') return 'This code expired';
  return ipcErrorMessage(cause, fallback);
}

/** This computer's name for "<name> joins your computers"; the confirm still works without it. */
async function thisComputerName(): Promise<string> {
  try {
    const report: ComputerRoutesReport = await window.electronAPI.invoke('computers:routes-report');
    return report.name;
  } catch {
    return 'This computer';
  }
}

/** Phone access (the relay) is off on this computer; unknown counts as on, so nothing claims a change it didn't see. */
export async function phoneAccessIsOff(): Promise<boolean> {
  try {
    const status: RelayStatus = await window.electronAPI.invoke('relay:status');
    return !status.enabled;
  } catch {
    return false;
  }
}

export const useAddDeviceStore = create<AddDeviceState>((set, get) => {
  const redeem = async (link: string, source: LinkSource, maker: string, generation: number) => {
    set({ flow: { step: 'linking', source, maker } });
    try {
      // Linking turns phone access on in place when it is off; the result says so.
      const wasOff = await phoneAccessIsOff();
      const result: LinkRedeemResult = await window.electronAPI.invoke('relay:redeem-link', { link });
      if (generation === flowGeneration) set({ flow: { step: 'linked', source, maker, linked: result.linked, turnedOnPhoneAccess: wasOff } });
    } catch (cause) {
      if (generation === flowGeneration) set({ flow: { step: 'failed', source, message: refusal(cause, `Pane couldn't link with ${maker}`) } });
    }
  };

  return {
    isOpen: false,
    tab: 'phone',
    computerId: null,
    open: (tab, options) => set({ isOpen: true, tab, computerId: options?.computerId ?? null }),
    close: () => {
      const { flow } = get();
      // A pasted link's state belongs to the dialog; the full-page confirm outlives it.
      set({ isOpen: false, computerId: null, maker: null, copied: null, copyError: null, flow: flow.step !== 'idle' && flow.source === 'paste' ? IDLE : flow });
    },
    setTab: (tab) => set({ tab }),

    expiresIn: '1h',
    setExpiresIn: (expiresIn) => set({ expiresIn }),
    copied: null,
    copyError: null,
    copyLink: async () => {
      set({ copyError: null });
      try {
        const info: RelayPairingInfo = await window.electronAPI.invoke('relay:pairing-code', { expiresIn: get().expiresIn });
        await navigator.clipboard.writeText(info.url);
        copiedALink = true;
        set({ copied: info });
      } catch (cause) {
        set({ copied: null, copyError: ipcErrorMessage(cause, "Pane couldn't make a link") });
      }
    },

    flow: IDLE,
    startLink: async (text, source) => {
      const generation = ++flowGeneration;
      const link = text.trim();
      if (!parseRelayPairingLink(link)) {
        set({ flow: { step: 'failed', source, message: "This isn't a Pane link. Copy it again from Add a device › Computer on the other computer." } });
        return;
      }
      set({ flow: { step: 'checking', source } });
      let preview: LinkPreview;
      let here: string;
      try {
        const previewing: Promise<LinkPreview> = window.electronAPI.invoke('relay:link-preview', { link });
        [preview, here] = await Promise.all([previewing, thisComputerName()]);
      } catch (cause) {
        if (generation === flowGeneration) set({ flow: { step: 'failed', source, message: refusal(cause, "Pane couldn't read this link") } });
        return;
      }
      if (generation !== flowGeneration) return;
      if (preview.needsConfirm) {
        set({ flow: { step: 'confirm', source, link, preview, here } });
        return;
      }
      await redeem(link, source, preview.maker, generation);
    },
    confirmLink: async () => {
      const { flow } = get();
      if (flow.step !== 'confirm') return;
      await redeem(flow.link, flow.source, flow.preview.maker, flowGeneration);
    },
    cancelLink: () => {
      flowGeneration += 1;
      set({ flow: IDLE });
    },

    maker: null,
    unlinkMaker: async () => {
      const { maker } = get();
      if (!maker?.computerId || maker.unlink === 'busy') return;
      set({ maker: { ...maker, unlink: 'busy' } });
      let outcome: string;
      try {
        const result: { removed: string[]; notReached: string[] } = await window.electronAPI.invoke(
          RELAY_DEVICE_COMMANDS.undoJoin,
          { computerId: maker.computerId },
        );
        const unlinked = result.removed.length > 0 ? result.removed.join(', ') : maker.label;
        outcome = result.notReached.length > 0
          ? `Unlinked ${unlinked}. ${result.notReached.join(', ')} didn't answer; Pane removes the link there when they come back.`
          : `Unlinked ${unlinked} from your computers.`;
      } catch (cause) {
        outcome = `${maker.label} is still linked: ${ipcErrorMessage(cause, "Pane couldn't reach your other computers")}. Try again.`;
      }
      set((state) => (state.maker ? { maker: { ...state.maker, unlink: 'done', outcome } } : {}));
    },
  };
});

/**
 * Listens for links opened from outside (`relay:link-opened`, shown on the full-page confirm) and for the
 * computer that used a link this dialog copied (`relay:paired`, shown on the Computer tab). Returns the unsubscribe.
 */
export function startAddDeviceListeners(): () => void {
  const { events } = window.electronAPI;
  const offOpened = events.onRelayLinkOpened(({ link }: RelayLinkOpenedEvent) => {
    // The full-page confirm replaces whatever the dialog showed, an earlier "Linked with" included.
    useAddDeviceStore.getState().close();
    void useAddDeviceStore.getState().startLink(link, 'opened');
  });
  const offPaired = events.onRelayPaired((event: RelayPairedEvent) => {
    // The dialog reopens on the result even when it was closed, so "Not you?" is always seen.
    if (event.kind !== 'computer' || !copiedALink) return;
    useAddDeviceStore.setState({
      maker: { label: event.label, computerId: event.computerId, unlink: 'idle' },
      isOpen: true,
      tab: 'computer',
    });
  });
  return () => {
    offOpened();
    offPaired();
  };
}
