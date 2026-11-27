import { useContext, type ReactNode } from 'react';
import { Check, Clock, CornerUpLeft, ListChecks, ArrowUp, Zap, AlertCircle, ChevronDown, ChevronRight, MessageSquareReply } from 'lucide-react';
import type { AgentMessageRecord } from '../../../../shared/types/agentMessages';
import { messageStatus, ownWorkerExchange, senderInitials, senderOfName, threadReplies, threadRoot, type ChatAgentLine, type ChatSender, type MessageStatus } from '../../../../shared/agentMessagePresentation';
import { messageTime } from '../../../../shared/chatTabPresentation';
import { ChatCopyButton } from './ChatCopyButton';
import { AgentMessagesContext } from './agentMessagesContext';
import { setAgentMessageOpen, useAgentMessageOpen } from './agentMessageOpenState';
import { ReferencedText } from './ReferencedText';

/**
 * Agent-sent messages and their replies in a chat (T-105, D-1 "cards, reply inside the card"):
 * a message another agent, Pane's To-dos or Autopilot typed into this tab is a card with its
 * sender, and its reply sits in the card's lower half, in the receiver's chat and the sender's.
 */

function Avatar({ sender }: { sender: ChatSender }) {
  const Icon = sender.system === 'todos' ? ListChecks : sender.system === 'autopilot' ? Zap : undefined;
  // The avatar slot: initials today, a profile picture later.
  return <span className="chat-agent-avatar" data-system={sender.system} aria-hidden="true">{Icon ? <Icon /> : senderInitials(sender.name)}</span>;
}

function Time({ iso }: { iso?: string }) {
  const time = messageTime(iso);
  return time ? <time className="chat-agent-time" dateTime={iso} title={time.full}>{time.short}</time> : null;
}

/** Swapping status pills share one box shape, so the footer never shifts. */
function StatusPill({ status, compact = false }: { status: MessageStatus; compact?: boolean }) {
  switch (status.state) {
    case 'answered': return <span className="chat-agent-pill" data-state="answered"><Check aria-hidden="true" />Answered</span>;
    case 'waiting': return <span className="chat-agent-pill" data-state="waiting"><Clock aria-hidden="true" />Waiting for reply</span>;
    case 'sending': return <span className="chat-agent-pill" data-state="sending"><Clock aria-hidden="true" />Sending</span>;
    case 'undelivered': return <span className="chat-agent-pill" data-state="undelivered" title={status.reason}><AlertCircle aria-hidden="true" />{compact ? 'Not delivered' : `Not delivered: ${status.reason}`}</span>;
  }
}

/** A reply's own delivery: Answered once it reached the sender, else why not yet. */
function ReplyPill({ reply }: { reply: AgentMessageRecord }) {
  if (reply.state === 'undelivered') return <StatusPill status={{ state: 'undelivered', reason: reply.undeliveredReason ?? 'it could not be delivered' }} />;
  if (reply.state === 'queued') return <span className="chat-agent-pill" data-state="waiting" title="Pane types it when the sender's tab is at its prompt"><Clock aria-hidden="true" />Reply queued</span>;
  if (reply.state === 'sending') return <StatusPill status={{ state: 'sending' }} />;
  return <StatusPill status={{ state: 'answered', replies: [] }} />;
}

/** One reply in a card's lower half. */
function ReplySection({ reply, renderText }: { reply: AgentMessageRecord; renderText: (text: string) => ReactNode }) {
  const { panelId } = useContext(AgentMessagesContext);
  const who = reply.sender.panelId !== null && reply.sender.panelId === panelId ? 'This agent' : senderOfName(reply.sender.name).name;
  const time = messageTime(reply.createdAt);
  return <div className="chat-agent-reply" data-testid="agent-message-reply" data-ref={reply.ref}>
    <div className="chat-agent-head">
      <CornerUpLeft className="chat-agent-reply-icon" aria-hidden="true" />
      <span className="chat-agent-name">{who}</span>
      <span className="chat-agent-kind">replied{time ? ` · ${time.short}` : ''}</span>
      <span className="chat-agent-spacer" />
      <ReplyPill reply={reply} />
    </div>
    <div className="chat-agent-body">{renderText(reply.text)}</div>
  </div>;
}

/** A file-pointer message's body (`Read and follow <file>`, T-104) is a path, not markdown: `__x__` in it stays as typed. */
const POINTER = /^Read and follow \S+/u;
const plainBody = (text: string) => <span className="whitespace-pre-wrap"><ReferencedText text={text} /></span>;

/** The first words of a collapsed card's text, on one line. */
const preview = (text: string) => text.replace(/\s+/gu, ' ').trim().slice(0, 240);

/** Failed sends this card's message retried (T-133): one note instead of a card each. */
function Attempts({ attempts }: { attempts: readonly AgentMessageRecord[] }) {
  const title = attempts.map(attempt => `${attempt.ref}: not delivered: ${attempt.undeliveredReason ?? 'it could not be delivered'}`).join('\n');
  const count = attempts.length === 1 ? '1 failed attempt' : `${attempts.length} failed attempts`;
  return <span className="chat-agent-attempts" data-testid="agent-message-attempts" title={title}><AlertCircle aria-hidden="true" />{count} ({attempts.map(attempt => attempt.ref).join(', ')}), sent again</span>;
}

/**
 * The card itself: header, body, then a footer (waiting) or the replies (answered). A message
 * between this Session's orchestrator and its own worker starts collapsed to one line (T-133):
 * the person opens it, and the card remembers.
 */
function Card({ anchorId, who, compactWho, meta, body, record, hint, copyText, renderText, outgoing = false }: {
  anchorId: string; who: ReactNode; compactWho?: ReactNode; meta: ReactNode; body: string; record?: AgentMessageRecord; hint?: ReactNode; copyText: string;
  renderText: (text: string) => ReactNode; outgoing?: boolean;
}) {
  const { byRef, panelId, attempts } = useContext(AgentMessagesContext);
  const status = record ? messageStatus(record, byRef) : undefined;
  const collapsible = record !== undefined && ownWorkerExchange(record, panelId);
  const [open, setOpen] = useAgentMessageOpen(panelId, record?.ref, !collapsible);
  const failed = record ? attempts.get(record.ref) : undefined;
  // Without a record (the PWA, the phone) the reply hint still shows: the card hides the line Pane added.
  const footHint = status ? status.state === 'waiting' && hint : hint;
  const card = { className: 'chat-agent-card', tabIndex: -1, 'data-pane-part': 'chat-message', 'data-anchor-id': anchorId, 'data-testid': 'agent-message-card', 'data-ref': record?.ref, 'data-state': status?.state } as const;
  const actions = <div className="chat-message-actions"><ChatCopyButton label="Copy message" text={() => copyText} /></div>;
  if (collapsible && !open) {
    return <div className="chat-agent-row" data-outgoing={outgoing}>
      <div {...card} data-collapsed="true">
        <button type="button" className="chat-agent-compact" aria-expanded={false} aria-label={`Show message ${record.ref}`} onClick={() => setOpen(true)}>
          {compactWho ?? who}
          <span className="chat-agent-preview">{preview(body)}</span>
          {meta}
          {status && <StatusPill status={status} compact />}
          <ChevronRight className="chat-agent-chevron" aria-hidden="true" />
        </button>
      </div>
      {actions}
    </div>;
  }
  return <div className="chat-agent-row" data-outgoing={outgoing}>
    <div {...card}>
      <div className="chat-agent-head">{who}<span className="chat-agent-spacer" />{meta}
        {collapsible && <button type="button" className="chat-agent-toggle" aria-expanded={true} aria-label={`Collapse message ${record.ref}`} onClick={() => setOpen(false)}><ChevronDown aria-hidden="true" /></button>}
      </div>
      <div className="chat-agent-body">{POINTER.test(body) ? plainBody(body) : renderText(body)}</div>
      {((status && status.state !== 'answered') || footHint || failed) && <div className="chat-agent-foot">{status && status.state !== 'answered' && <StatusPill status={status} />}{footHint}{failed && <Attempts attempts={failed} />}</div>}
      {status?.state === 'answered' && threadReplies(status.replies, byRef).map(reply => <ReplySection key={reply.ref} reply={reply} renderText={renderText} />)}
    </div>
    {actions}
  </div>;
}

function Ref({ value }: { value: string }) {
  return <span className="chat-agent-ref">{value}</span>;
}

/** A message typed into this tab by another agent, Pane's To-dos or Autopilot. */
function IncomingCard({ line, anchorId, startedAt, text, renderText }: { line: Extract<ChatAgentLine, { type: 'message' }>; anchorId: string; startedAt?: string; text: string; renderText: (text: string) => ReactNode }) {
  const { byRef } = useContext(AgentMessagesContext);
  const record = line.ref ? byRef.get(line.ref) : undefined;
  const hint = line.ref && <span className="chat-agent-hint"><CornerUpLeft aria-hidden="true" />reply with <code>runpane reply {line.ref}</code></span>;
  return <Card anchorId={anchorId} body={line.body} record={record} hint={hint} copyText={text} renderText={renderText} who={<>
    <Avatar sender={line.sender} />
    <span className="chat-agent-name">{line.sender.name}</span>
    {line.sender.kind && <span className="chat-agent-kind">{line.sender.kind}</span>}
  </>} compactWho={<>
    <Avatar sender={line.sender} />
    <span className="chat-agent-kind">From</span>
    <span className="chat-agent-name">{line.sender.name}</span>
  </>} meta={<>
    {line.ref && <Ref value={line.ref} />}
    <Time iso={record?.createdAt ?? startedAt} />
  </>} />;
}

/** A message this tab's agent sent, at the end of the turn that sent it; its reply fills in below. */
export function SentMessageCards({ turnId, renderText }: { turnId: string; renderText: (text: string) => ReactNode }) {
  const { sentByTurn } = useContext(AgentMessagesContext);
  const sent = sentByTurn.get(turnId);
  if (!sent?.length) return null;
  return <>{sent.map(record => {
    const to = senderOfName(record.receiver.name);
    return <Card key={record.ref} outgoing anchorId={`agent-message:${record.ref}`} body={record.text} record={record} copyText={record.text} renderText={renderText} who={<>
      <Avatar sender={senderOfName(record.sender.name)} />
      <span className="chat-agent-kind">Sent to</span>
      <span className="chat-agent-name">{to.name}</span>
    </>} meta={<>
      <Ref value={record.ref} />
      <Time iso={record.createdAt} />
    </>} />;
  })}</>;
}

/** A reply arriving here: when its message's card is in this chat the reply shows there, so this is one line that jumps to it. */
function ReplyArrival({ line, anchorId, startedAt, text, renderText }: { line: Extract<ChatAgentLine, { type: 'reply' }>; anchorId: string; startedAt?: string; text: string; renderText: (text: string) => ReactNode }) {
  const { byRef, sentByTurn, shownHere, panelId } = useContext(AgentMessagesContext);
  // The card that holds this reply: the thread's first message, when its card is loaded in this chat.
  const root = threadRoot(line.replyTo, byRef);
  const first = byRef.get(root);
  const cardHere = [...sentByTurn.values()].some(sent => sent.some(record => record.ref === root)) || shownHere.has(root);
  // Only a reply that card's thread really shows becomes a jump; anything else keeps its own text here.
  const shown = cardHere && first !== undefined && threadReplies(first.replies.flatMap(ref => byRef.get(ref) ?? []), byRef).some(reply => reply.ref === line.ref);
  if (shown) {
    const jump = () => {
      const selector = `[data-testid="agent-message-card"][data-ref="${CSS.escape(root)}"]`;
      const scroll = () => {
        const card = document.querySelector<HTMLElement>(selector);
        if (!card) return;
        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        card.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
        card.focus({ preventScroll: true });
      };
      // A collapsed card (an own worker's, T-133) opens first, then scrolls once it has its full height.
      if (panelId && document.querySelector<HTMLElement>(selector)?.dataset.collapsed === 'true') {
        setAgentMessageOpen(panelId, root, true);
        requestAnimationFrame(scroll);
      } else scroll();
    };
    return <div className="chat-agent-arrival" data-pane-part="chat-message" data-anchor-id={anchorId} data-testid="agent-reply-arrival">
      <button type="button" className="chat-agent-jump" onClick={jump}><ArrowUp aria-hidden="true" />{line.sender.name} replied to {line.replyTo} above<Time iso={byRef.get(line.ref)?.createdAt ?? startedAt} /></button>
    </div>;
  }
  // Its message isn't in this chat (sent before a Switch to chat, or paged out): the reply is its own card.
  return <Card anchorId={anchorId} body={line.body} record={byRef.get(line.ref)} copyText={text} renderText={renderText} who={<>
    <Avatar sender={line.sender} />
    <span className="chat-agent-name">{line.sender.name}</span>
    <span className="chat-agent-kind">replied to</span>
    <Ref value={line.replyTo} />
  </>} meta={<>
    <Time iso={byRef.get(line.ref)?.createdAt ?? startedAt} />
  </>} />;
}

/** A line naming M-n that this tab's records can't vouch for: its text exactly as typed, credited to nobody. */
function UnverifiedLine({ line, anchorId, text }: { line: Extract<ChatAgentLine, { type: 'unverified' }>; anchorId: string; text: string }) {
  return <div className="chat-agent-row">
    <div className="chat-agent-card chat-agent-unverified" data-pane-part="chat-message" data-anchor-id={anchorId} data-testid="agent-message-unverified" data-ref={line.ref}>
      <div className="chat-agent-head"><span className="chat-agent-kind">Message</span><Ref value={line.ref} /><span className="chat-agent-kind">· not in this tab's message records</span></div>
      <div className="chat-agent-body">{plainBody(text)}</div>
    </div>
    <div className="chat-message-actions"><ChatCopyButton label="Copy message" text={() => text} /></div>
  </div>;
}

/** The person's words that Autopilot or To-dos passed on: still the 'You' bubble, with who carried them. */
function RelayedBubble({ line, anchorId, text, title }: { line: Extract<ChatAgentLine, { type: 'relayed' }>; anchorId: string; text: string; title?: string }) {
  const Icon = line.via === 'Autopilot' ? Zap : ListChecks;
  return <div className="chat-user-row" title={title}>
    <div className="chat-relayed-caption" data-testid="relayed-caption"><Icon aria-hidden="true" />You, via {line.via}</div>
    <div className="chat-user whitespace-pre-wrap" data-pane-part="chat-message" data-anchor-id={anchorId}>{line.body}</div>
    <div className="chat-message-actions"><ChatCopyButton label="Copy message" text={() => text} /></div>
  </div>;
}

/**
 * Pane's own line about an approval (`answer: Q-4 → … (by you)`, `reply:`, `closed:`, `correction:`),
 * which its record vouches for: one quiet system line, not the person's bubble (T-133). The text stays as typed.
 */
function PaneLine({ anchorId, text, title }: { anchorId: string; text: string; title?: string }) {
  return <div className="chat-pane-line" data-pane-part="chat-message" data-anchor-id={anchorId} data-testid="pane-approval-line" title={title}>
    <span className="chat-pane-line-icon" aria-hidden="true"><MessageSquareReply /></span>
    <span className="chat-pane-line-who">Pane</span>
    <span className="chat-pane-line-text">{text}</span>
    <span className="chat-message-actions"><ChatCopyButton label="Copy message" text={() => text} /></span>
  </div>;
}

/** A message Pane or another agent typed into this tab, drawn by what it is. */
export function AgentLineView({ line, anchorId, startedAt, text, renderText }: { line: ChatAgentLine; anchorId: string; startedAt?: string; text: string; renderText: (text: string) => ReactNode }) {
  switch (line.type) {
    case 'message': return <IncomingCard line={line} anchorId={anchorId} startedAt={startedAt} text={text} renderText={renderText} />;
    case 'reply': return <ReplyArrival line={line} anchorId={anchorId} startedAt={startedAt} text={text} renderText={renderText} />;
    case 'unverified': return <UnverifiedLine line={line} anchorId={anchorId} text={text} />;
    case 'relayed': return <RelayedBubble line={line} anchorId={anchorId} text={text} title={messageTime(startedAt)?.full} />;
    case 'pane': return <PaneLine anchorId={anchorId} text={text.trim()} title={messageTime(startedAt)?.full} />;
  }
}
