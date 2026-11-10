import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatTabSwitchBanner } from '../../../../shared/types/chatTab';
import { ChatSwitchBanner } from './ChatSwitchBanner';
import { switchBannerCopy } from './switchBannerCopy';

const noop = () => undefined;
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'');

/** The element whose aria-label is `label`, from a rendered tree. */
function byLabel(node: ReactNode, label: string): ReactElement<{ onClick?: () => void }> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = byLabel(child, label); if (found) return found; } return undefined; }
  if (!isValidElement<{ 'aria-label'?: string; children?: ReactNode; onClick?: () => void }>(node)) return undefined;
  if (node.props['aria-label'] === label) return node;
  return byLabel(node.props.children, label);
}

describe('the Switch to chat banner and notes (D-282, D-278 style 3)', () => {
  it('says the most recent conversation was opened, with Pick another and /resume', () => {
    const html = renderToStaticMarkup(<ChatSwitchBanner banner={{ kind: 'most-recent' }} onPickAnother={noop} onDismiss={noop} />);
    expect(text(html)).toContain('Opened the most recent conversation here');
    expect(text(html)).toContain('Pane wasn\'t sure which conversation the terminal was on, so it opened the latest one in this folder. Not the right one? Type /resume or pick another.');
    expect(html).toContain('<code>/resume</code>');
    expect(html).toContain('>Pick another<');
  });

  it.each<[ChatTabSwitchBanner, string]>([
    [{ kind: 'none' }, 'Pane wasn\'t sure which conversation the terminal was on, and this folder has none to open, so this chat starts new.'],
    [{ kind: 'known-empty' }, 'The terminal\'s conversation had no messages yet, so there was nothing to carry over.'],
    [{ kind: 'list-failed', reason: 'Codex is signed out' }, 'Pane wasn\'t sure which conversation the terminal was on and couldn\'t list this folder\'s conversations (Codex is signed out), so this chat starts new. Type /resume to try again.'],
  ])('notes a new conversation (%o) without Pick another', (banner, body) => {
    expect(switchBannerCopy(banner)).toMatchObject({ title: 'Started a new conversation', body, pickAnother: false });
    const html = renderToStaticMarkup(<ChatSwitchBanner banner={banner} onPickAnother={noop} onDismiss={noop} />);
    expect(text(html)).toContain('Started a new conversation');
    expect(html).not.toContain('Pick another');
  });

  it('closes on ✕, and Pick another opens the picker', () => {
    const onDismiss = vi.fn();
    const onPickAnother = vi.fn();
    const tree = ChatSwitchBanner({ banner: { kind: 'most-recent' }, onPickAnother, onDismiss });
    byLabel(tree, 'Close')?.props.onClick?.();
    expect(onDismiss).toHaveBeenCalledOnce();
    byLabel(tree, 'Pick another conversation')?.props.onClick?.();
    expect(onPickAnother).toHaveBeenCalledOnce();
  });
});
