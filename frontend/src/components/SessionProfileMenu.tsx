import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronRight, RotateCw } from 'lucide-react';
import type { AgentFarmProfileList } from '../../../shared/types/agentFarmProfiles';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { PopoverButton, TerminalPopover } from './terminal/TerminalPopover';
import { ProfileAvatar } from './profiles/ProfileAvatar';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';
import { cn } from '../utils/cn';
import { filterProfileSwitchChoices, profileSwitchChoices, profileSwitchText, type ProfileSwitchChoice } from '../utils/sessionProfileSwitch';

/** This computer's Agent Farm profiles, read while a Session's menu is open. */
function useLocalProfiles(open: boolean): { list?: AgentFarmProfileList; error?: string } | null {
  const [read, setRead] = useState<{ list?: AgentFarmProfileList; error?: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const request = window.electronAPI?.chatTab?.profiles?.() ?? Promise.resolve<AgentFarmProfileList>({ profiles: [] });
    request.then(
      list => { if (live) setRead({ list }); },
      (cause: unknown) => { if (live) setRead({ error: cause instanceof Error ? cause.message : 'Pane could not read this computer\'s profiles.' }); },
    );
    return () => { live = false; setRead(null); };
  }, [open]);
  return read;
}

interface SessionProfileMenuItemsProps {
  /** The Session the menu is for; undefined while the menu is closed. */
  session: OrchestrationSessionRecord | undefined;
  onSwitch: (session: OrchestrationSessionRecord, choice: ProfileSwitchChoice) => void;
  onReload: (session: OrchestrationSessionRecord) => void;
  /** Closes the whole menu. */
  onClose: () => void;
}

/**
 * Switch profile › and Reload profile in a Session's menu (T-63). The submenu opens on hover, click,
 * Return or →, filters as you type, and goes back with ← or Esc.
 */
export function SessionProfileMenuItems({ session, onSwitch, onReload, onClose }: SessionProfileMenuItemsProps) {
  const [submenu, setSubmenu] = useState<{ x: number; y: number; focus: boolean } | null>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { if (!session) setSubmenu(null); }, [session]);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const open = (focus: boolean) => {
    const bounds = itemRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setSubmenu({ x: bounds.right + 4, y: bounds.top - 6, focus });
  };
  const back = () => { setSubmenu(null); itemRef.current?.focus(); };
  const reloadNote = !session?.agentProfile ? 'no profile' : session.agentProfileChanged ? null : 'up to date';
  return (<>
    <div role="separator" className="my-1 border-t border-border-primary" />
    <PopoverButton
      ref={itemRef}
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={submenu !== null}
      data-testid="session-switch-profile"
      onClick={() => open(true)}
      onMouseEnter={() => { clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => open(false), 120); }}
      onMouseLeave={() => clearTimeout(hoverTimer.current)}
      onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); open(true); } }}
    >
      <span className="flex items-center gap-2">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {session && <ProfileAvatar profileRef={session.agentProfile?.ref} agent={session.agent} size={16} />}
        </span>
        <span className="flex-1">Switch profile</span>
        <ChevronRight className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
      </span>
    </PopoverButton>
    <PopoverButton
      role="menuitem"
      // Focusable while unavailable, so arrow keys reach it and its reason is announced.
      aria-disabled={!session?.agentProfile}
      data-testid="session-reload-profile"
      className={cn(!session?.agentProfile && 'cursor-not-allowed')}
      onClick={() => { if (session?.agentProfile) { onReload(session); onClose(); } }}
    >
      <span className={cn('flex items-center gap-2', !session?.agentProfile && 'opacity-50')}>
        <RotateCw className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1">Reload profile</span>
        {session?.agentProfileChanged
          ? <span className="flex h-3 w-3 items-center justify-center" title="The profile changed since this Session took it"><span className="h-1.5 w-1.5 rounded-full bg-status-warning" /><span className="sr-only">changed</span></span>
          : <span className="text-[11px] text-text-tertiary">{reloadNote}</span>}
      </span>
    </PopoverButton>
    <div role="separator" className="my-1 border-t border-border-primary" />
    {session && submenu && (
      <SwitchProfileSubmenu
        session={session}
        x={submenu.x}
        y={submenu.y}
        flipY={(itemRef.current?.getBoundingClientRect().bottom ?? submenu.y) + 6}
        autoFocus={submenu.focus}
        onBack={back}
        onPick={choice => { setSubmenu(null); onClose(); onSwitch(session, choice); }}
      />
    )}
  </>);
}

function SwitchProfileSubmenu({ session, x, y, flipY, autoFocus, onBack, onPick }: {
  session: OrchestrationSessionRecord; x: number; y: number; flipY: number; autoFocus: boolean;
  onBack: () => void; onPick: (choice: ProfileSwitchChoice) => void;
}) {
  const read = useLocalProfiles(true);
  const [query, setQuery] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const choices = useMemo(() => profileSwitchChoices(session, read?.list?.profiles ?? []), [read, session]);
  const shown = filterProfileSwitchChoices(choices, query);
  const current = session.agentProfile?.ref;
  useEffect(() => { if (autoFocus) filterRef.current?.focus(); }, [autoFocus]);

  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.findIndex(item => item === document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); (list[index + 1] ?? list[0])?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (index <= 0) filterRef.current?.focus(); else list[index - 1]?.focus(); }
    else if (event.key === 'ArrowLeft' && document.activeElement !== filterRef.current) { event.preventDefault(); onBack(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onBack(); }
    else if (event.key === 'Enter' && document.activeElement === filterRef.current) {
      event.preventDefault();
      const first = shown.find(choice => choice.ref !== current);
      if (first) onPick(first);
    }
    // Every key stays in the submenu: the Session menu under it moves its own focus on arrows.
    event.stopPropagation();
  };

  let lastGroup: ProfileSwitchChoice['group'] | null = null;
  return (
    <TerminalPopover visible submenu x={x} y={y} flipY={flipY} onClose={onBack} className="w-[300px]">
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- The menu's keys (arrows, Esc, Return) are handled once here for its filter and items. */}
      <div data-testid="session-switch-profile-menu" onKeyDown={handleKeyDown}>
        <div className="px-1 pb-1.5 pt-1">
          <input
            ref={filterRef}
            type="text"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Filter profiles"
            aria-label="Filter profiles"
            autoComplete="off"
            spellCheck={false}
            className="h-7 w-full rounded-md border border-border-primary bg-surface-secondary px-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-interactive"
          />
        </div>
        <div ref={listRef} role="menu" aria-label="Switch profile">
          {shown.map(choice => {
            const heading = !query && choice.group === 'profiles' && lastGroup !== 'profiles';
            lastGroup = choice.group;
            const selected = choice.ref === current;
            return (
              <div key={choice.key}>
                {heading && <>
                  <div role="separator" className="my-1 border-t border-border-primary" />
                  <div role="presentation" className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">Profiles on this computer</div>
                </>}
                <PopoverButton
                  role="menuitemradio"
                  aria-checked={selected}
                  data-testid={`session-switch-choice-${choice.key}`}
                  onClick={() => { if (!selected) onPick(choice); }}
                  className="py-1.5"
                >
                  <span className="flex items-center gap-2">
                    <ProfileAvatar profileRef={choice.avatarRef} agent={choice.agent} size={18} />
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-[13px]">{choice.label}</span>
                      <span className="truncate text-[11px] text-text-tertiary">{choice.detail}</span>
                    </span>
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">{selected && <Check className="h-3.5 w-3.5" aria-hidden="true" />}</span>
                  </span>
                </PopoverButton>
              </div>
            );
          })}
          {read === null && <p className="px-3 py-1.5 text-[12px] text-text-tertiary">Reading this computer's profiles…</p>}
          {read?.error && <p className="px-3 py-1.5 text-[12px] text-text-tertiary">Profiles unavailable: {read.error}</p>}
          {read !== null && !shown.length && <p className="px-3 py-1.5 text-[12px] text-text-tertiary">No profile matches</p>}
        </div>
      </div>
    </TerminalPopover>
  );
}

/** Asks first when a switch can't keep the conversation (A-2): between Claude and Codex, or Codex profiles. */
export function ProfileSwitchConfirm({ pending, onCancel, onConfirm }: {
  pending: { session: OrchestrationSessionRecord; choice: ProfileSwitchChoice } | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const text = pending ? profileSwitchText(pending.session, pending.choice) : null;
  return (
    <Modal isOpen={pending !== null} onClose={onCancel} size="sm" ariaLabel={text?.confirmTitle ?? 'Switch profile'}>
      <ModalHeader title={text?.confirmTitle ?? ''} />
      <ModalBody>
        <div className="space-y-2 text-sm text-text-secondary" data-testid="profile-switch-confirm">
          <p>{text?.confirmReason}</p>
          <p>Same Session, folder, Panes and to-dos.</p>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="button" autoFocus onClick={onConfirm}>Switch</Button>
      </ModalFooter>
    </Modal>
  );
}

/** The amber dot on a Session row whose profile changed since it took it: Reload profile takes the new one. */
export function ProfileChangedDot({ session }: { session: Pick<OrchestrationSessionRecord, 'agentProfileChanged'> }) {
  if (!session.agentProfileChanged) return null;
  return (
    <span className="pointer-events-none flex h-3 w-3 flex-shrink-0 items-center justify-center" data-testid="session-profile-changed" title="Profile changed: right-click › Reload profile">
      <span className="h-1.5 w-1.5 rounded-full bg-status-warning" aria-hidden="true" />
      <span className="sr-only">Profile changed</span>
    </span>
  );
}
