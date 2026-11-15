import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LinkPreview, LinkRedeemResult, RelayLinkOpenedEvent, RelayPairedEvent } from '../../../../shared/types/relay';
import { startAddDeviceListeners, useAddDeviceStore } from './addDeviceStore';
import { MakerResultView } from './ComputerTab';
import { LinkFlowView } from './LinkConfirm';

const LINK = 'https://runpane.net/pair#s=k3x9q2secret&c=studio-mac&n=Studio%20Mac';

/** Build Box (here, already linked with Lab PC) opening a link Studio Mac made; Studio Mac is linked with Travel Laptop and Old iMac. */
const JOINING_TWO_GROUPS: LinkPreview = {
  maker: 'Studio Mac',
  makerGroup: ['Studio Mac', 'Travel Laptop', 'Old iMac'],
  here: ['Lab PC'],
  needsConfirm: true,
  expiresAt: '2026-11-15T10:00:00Z',
};

const NOTHING_HERE: LinkPreview = { ...JOINING_TWO_GROUPS, here: [], needsConfirm: false };

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
/** What the dialog or the full page shows for the store's current link (server rendering reads a store's initial state). */
function renderFlow(): string {
  const { flow } = useAddDeviceStore.getState();
  if (flow.step === 'idle') throw new Error('no link in progress');
  return renderToStaticMarkup(<LinkFlowView flow={flow} onDone={() => undefined} />);
}
function renderMaker(): string {
  const { maker } = useAddDeviceStore.getState();
  if (!maker) throw new Error('no maker result');
  return renderToStaticMarkup(<MakerResultView maker={maker} />);
}
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) => text(match[1]).trim());

let preview: LinkPreview;
let redeem: () => Promise<LinkRedeemResult>;
let emitOpened: (event: RelayLinkOpenedEvent) => void;
let emitPaired: (event: RelayPairedEvent) => void;
const invoke = vi.fn(async (channel: string, ..._args: object[]): Promise<object> => {
  switch (channel) {
    case 'relay:link-preview': return preview;
    case 'relay:redeem-link': return redeem();
    case 'computers:routes-report': return { machineId: 'm-build', name: 'Build Box' };
    case 'relay:pairing-code': return { url: LINK, expiresAt: '2026-11-15T10:00:00Z' };
    case 'relay:undo-join': return { removed: ['Build Box', 'NAS'], notReached: [] };
    default: throw new Error(`unexpected ${channel}`);
  }
});
const callsTo = (channel: string) => invoke.mock.calls.filter(([name]) => name === channel).map(([, ...args]) => args);
const writeText = vi.fn(async (_text: string) => undefined);
let stop: () => void;

beforeEach(() => {
  invoke.mockClear();
  writeText.mockClear();
  preview = JOINING_TWO_GROUPS;
  redeem = async () => ({ linked: ['Studio Mac', 'Travel Laptop', 'Old iMac', 'Lab PC'] });
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('window', {
    electronAPI: {
      invoke,
      events: {
        onRelayLinkOpened: (callback: typeof emitOpened) => { emitOpened = callback; return () => undefined; },
        onRelayPaired: (callback: typeof emitPaired) => { emitPaired = callback; return () => undefined; },
      },
    },
  });
  stop = startAddDeviceListeners();
});

afterEach(() => {
  stop();
  useAddDeviceStore.getState().close();
  useAddDeviceStore.getState().cancelLink();
  useAddDeviceStore.setState({ expiresIn: '1h' });
  vi.unstubAllGlobals();
});

describe('Add a device › Computer: copying a link', () => {
  it('mints a 1-hour link unless another lifetime is chosen', async () => {
    const store = useAddDeviceStore.getState();
    await store.copyLink();
    store.setExpiresIn('10m');
    await useAddDeviceStore.getState().copyLink();
    useAddDeviceStore.getState().setExpiresIn('24h');
    await useAddDeviceStore.getState().copyLink();

    expect(callsTo('relay:pairing-code')).toEqual([[{ expiresIn: '1h' }], [{ expiresIn: '10m' }], [{ expiresIn: '24h' }]]);
    expect(writeText).toHaveBeenLastCalledWith(LINK);
  });
});

describe('Add a device › Computer: pasting a link', () => {
  it('names every computer on both sides, then links on "Link"', async () => {
    await useAddDeviceStore.getState().startLink(`  ${LINK}\n`, 'paste');

    expect(useAddDeviceStore.getState().flow.step).toBe('confirm');
    const markup = renderFlow();
    expect(text(markup)).toContain('Link this computer with Studio Mac');
    expect(text(markup)).toContain('Build Box joins your computers.');
    for (const name of ['Studio Mac made this link', 'Travel Laptop', 'Old iMac', 'Lab PC linked with Build Box']) {
      expect(text(markup)).toContain(name);
    }
    expect(buttons(markup)).toEqual(['Not mine, cancel', 'Link Build Box']);
    expect(callsTo('relay:redeem-link')).toEqual([]);

    await useAddDeviceStore.getState().confirmLink();

    expect(callsTo('relay:link-preview')).toEqual([[{ link: LINK }]]);
    expect(callsTo('relay:redeem-link')).toEqual([[{ link: LINK }]]);
    expect(useAddDeviceStore.getState().flow).toMatchObject({ step: 'linked', maker: 'Studio Mac' });
    expect(text(renderFlow())).toContain('This computer now reaches Studio Mac and 3 other computers.');
  });

  it('"Not mine, cancel" redeems nothing, so the link stays usable', async () => {
    await useAddDeviceStore.getState().startLink(LINK, 'paste');
    useAddDeviceStore.getState().cancelLink();

    expect(useAddDeviceStore.getState().flow).toEqual({ step: 'idle' });
    expect(callsTo('relay:redeem-link')).toEqual([]);
  });

  it.each([
    ['ERR_PAIRING_CODE_EXPIRED', 'This code expired. Scan the new code on the computer.', 'This code expired'],
    ['ERR_PAIRING_CODE_USED', 'This code was already used. Scan the new code on the computer.', 'This code was already used'],
  ])('shows a %s refusal in today\'s words', async (code, message, shown) => {
    preview = NOTHING_HERE;
    redeem = async () => { throw new Error(`Error invoking remote method 'relay:redeem-link': Error [${code}]: ${message}`); };

    await useAddDeviceStore.getState().startLink(LINK, 'paste');

    expect(useAddDeviceStore.getState().flow).toEqual({ step: 'failed', source: 'paste', message: shown });
  });

  it('refuses text that is not a Pane link without asking the backend', async () => {
    await useAddDeviceStore.getState().startLink('https://example.com/pair', 'paste');

    expect(useAddDeviceStore.getState().flow).toMatchObject({ step: 'failed' });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('A pane://pair link opened on this computer', () => {
  it('links without asking when nothing is linked here, and shows the result full page', async () => {
    preview = NOTHING_HERE;
    redeem = async () => ({ linked: ['Studio Mac', 'Travel Laptop', 'Old iMac'] });

    emitOpened({ link: LINK });
    await vi.waitFor(() => expect(useAddDeviceStore.getState().flow.step).toBe('linked'));

    expect(callsTo('relay:redeem-link')).toEqual([[{ link: LINK }]]);
    expect(useAddDeviceStore.getState().flow).toMatchObject({ source: 'opened' });
    const page = text(renderFlow());
    expect(page).toContain('Linked with Studio Mac');
    expect(page).toContain('This computer now reaches Studio Mac and 2 other computers.');
  });

  it('asks on the full page when this computer already reaches others', async () => {
    emitOpened({ link: LINK });
    await vi.waitFor(() => expect(useAddDeviceStore.getState().flow.step).toBe('confirm'));

    expect(useAddDeviceStore.getState().flow).toMatchObject({ source: 'opened' });
    expect(buttons(renderFlow())).toEqual(['Not mine, cancel', 'Link Build Box']);
    expect(callsTo('relay:redeem-link')).toEqual([]);
  });

  it('closes an earlier "Linked with" dialog so the full-page confirm is on top', async () => {
    await useAddDeviceStore.getState().copyLink();
    emitPaired({ kind: 'computer', label: 'Lab PC', computerId: 'lab-pc' });
    expect(useAddDeviceStore.getState().isOpen).toBe(true);

    emitOpened({ link: LINK });
    await vi.waitFor(() => expect(useAddDeviceStore.getState().flow.step).toBe('confirm'));

    expect(useAddDeviceStore.getState()).toMatchObject({ isOpen: false, maker: null });
  });
});

describe('The computer that made the link', () => {
  it('shows who used it, with "Not you? Unlink" that undoes the link', async () => {
    await useAddDeviceStore.getState().copyLink();
    useAddDeviceStore.getState().close();

    emitPaired({ kind: 'phone', label: "Parsa's iPhone" });
    expect(useAddDeviceStore.getState().isOpen).toBe(false);

    emitPaired({ kind: 'computer', label: 'Build Box', computerId: 'build-box' });
    expect(useAddDeviceStore.getState()).toMatchObject({ isOpen: true, tab: 'computer' });
    const markup = renderMaker();
    expect(text(markup)).toContain('Linked with Build Box');
    expect(text(markup)).toContain('Not you? Unlink Build Box');

    await useAddDeviceStore.getState().unlinkMaker();

    expect(callsTo('relay:undo-join')).toEqual([[{ computerId: 'build-box' }]]);
    expect(text(renderMaker())).toContain('Unlinked Build Box, NAS from your computers.');
  });
});
