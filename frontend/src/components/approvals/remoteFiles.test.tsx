import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NotifyItem } from '../../../../shared/types/notify';
import { MachineFileFrame, SummaryView } from './ApprovalColumn';
import { MachineDocView } from './MachineContext';
import { linkedFileReadsHere, readMachineDoc } from './machineDoc';
import { readSummaryPage } from './summaryPage';

const remote: NotifyItem = {
  id: 'mini:q7', machineId: 'mini', machine: 'tylers-mac-mini', ui: 'approve', title: 'Approve the plan?', state: 'waiting', createdAt: 1,
  source: { name: 'planner', agent: 'Claude' },
  links: [{ label: 'Plan draft', path: '/work/bundle/plan.html' }],
};
const local: NotifyItem = { ...remote, id: 'q7', machineId: 'local', machine: 'MacBook' };

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const stubRead = (read: (machineId: string, channel: string, args: unknown[]) => Promise<{ machineId: string; data: unknown }>) => {
  const spy = vi.fn(read);
  vi.stubGlobal('window', { electronAPI: { machines: { read: spy, retry: vi.fn(async () => undefined) } } });
  return spy;
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('an approval from another machine opens its files here', () => {
  it('local: a local approval in the local view still opens in this computer\'s document viewer', () => {
    expect(linkedFileReadsHere(local, 'local')).toBe(true);
    expect(linkedFileReadsHere({ machineId: undefined }, 'local')).toBe(true);
  });

  it('remote reference: read from the approval\'s machine, in the All machines view too', async () => {
    expect(linkedFileReadsHere(remote, 'local')).toBe(false);
    expect(linkedFileReadsHere(local, 'mini')).toBe(false);
    const read = stubRead(async (machineId) => ({ machineId, data: { kind: 'html', html: '<h1>Plan</h1>', path: '/work/bundle/plan.html' } }));
    expect(await readMachineDoc(remote, '/work/bundle/plan.html')).toEqual({ kind: 'html', html: '<h1>Plan</h1>' });
    // Only the linked path, read-only, through the read the machine already serves for its own approvals' links.
    expect(read).toHaveBeenCalledWith('mini', 'autopilot:read-doc', ['/work/bundle/plan.html', { inline: true }]);
  });

  it('remote reference: shows like a local file, with "on <machine>" in the header', () => {
    const markup = renderToStaticMarkup(
      <MachineFileFrame item={remote} label="Plan draft">
        <MachineDocView doc={{ kind: 'html', html: '<h1>Plan</h1>' }} label="Plan draft" machine="tylers-mac-mini" />
      </MachineFileFrame>,
    );
    expect(text(markup)).toContain('Plan draft · on tylers-mac-mini');
    expect(markup).toContain('data-testid="approvals-machine-page"');
    expect(text(markup)).not.toContain('open it there');
  });

  it('a local approval\'s file names no machine', () => {
    const markup = renderToStaticMarkup(<MachineFileFrame item={local} label="Plan draft"><span /></MachineFileFrame>);
    expect(text(markup)).not.toContain(' on ');
  });

  it('offline: a clear line with Retry', () => {
    const markup = renderToStaticMarkup(<MachineDocView doc={{ kind: 'unreachable' }} label="Plan draft" machine="tylers-mac-mini" onRetry={() => undefined} />);
    expect(text(markup)).toContain("Couldn't reach tylers-mac-mini Retry");
    // A file that's gone isn't helped by Retry.
    expect(renderToStaticMarkup(<MachineDocView doc={{ kind: 'missing' }} label="Plan draft" machine="tylers-mac-mini" onRetry={() => undefined} />)).not.toContain('Retry');
  });

  it('remote Summary: read from its machine by that machine\'s id, shown "on <machine>"', async () => {
    const read = stubRead(async (machineId) => ({ machineId, data: { kind: 'page', path: '/work/bundle/summary.html', html: '<p>s</p>' } }));
    const page = await readSummaryPage(remote, 'dark');
    expect(read).toHaveBeenCalledWith('mini', 'notify:summary-page', ['q7', { theme: 'dark' }]);
    expect(page).toEqual({ kind: 'page', path: '/work/bundle/summary.html', html: '<p>s</p>' });
    const markup = renderToStaticMarkup(<SummaryView item={remote} page={page} onRetry={() => undefined} />);
    expect(text(markup)).toContain('summary.html · on tylers-mac-mini');
    expect(markup).toContain('data-testid="approval-summary-frame"');
  });

  it('remote Summary offline: the reason, with Retry', async () => {
    stubRead(async () => { throw new Error('tylers-mac-mini is offline'); });
    const page = await readSummaryPage(remote, 'light');
    expect(page.kind).toBe('failed');
    expect(text(renderToStaticMarkup(<SummaryView item={remote} page={page} onRetry={() => undefined} />))).toMatch(/offline Retry/);
  });
});
