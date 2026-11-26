import { useContext, type ReactNode } from 'react';
import { Check, Clock, CornerUpLeft, ListChecks, ArrowUp, Zap, AlertCircle } from 'lucide-react';
import type { AgentMessageRecord } from '../../../../shared/types/agentMessages';
import { messageStatus, senderInitials, senderOfName, type ChatAgentLine, type ChatSender, type MessageStatus } from '../../../../shared/agentMessagePresentation';
import { messageTime } from '../../../../shared/chatTabPresentation';
import { ChatCopyButton } from './ChatCopyButton';
import { AgentMessagesContext } from './agentMessagesContext';

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
function StatusPill({ status }: { status: MessageStatus }) {
  switch (status.state) {
    case 'answered': return <span className="chat-agent-pill" data-state="answered"><Check aria-hidden="true" />Answered</span>;
    case 'waiting': return <span className="chat-agent-pill" data-state="waiting"><Clock aria-hidden="true" />Waiting for reply</span>;
    case 'sending': return <span className="chat-agent-pill" data-state="sending"><Clock aria-hidden="true" />Sending</span>;
    case 'undelivered': return <span className="chat-agent-pill" data-state="undelivered" title={status.reason}><AlertCircle aria-hidden="true" />Not delivered: {status.reason}</span>;
  }
}

function ReplySection({ reply, panelId, renderText }: { reply: AgentMessageRecord; panelId?: string; renderText: (text: string) => ReactNode }) {
  const who = reply.sender.panelId !== null && reply.sender.panelId === panelId ? 'This agent' : senderOfName(reply.sender.name).name;
  return <div className="chat-agent-reply" data-testid="agent-message-reply" data-ref={reply.ref}>
    <div className="chat-agent-head">
      <CornerUpLeft className="chat-agent-reply-icon" aria-hidden="true" />
      <span className="chat-agent-name">{who}</span>
      <span className="chat-agent-kind">replied{messageTime(reply.createdAt) ? ` · ${messageTime(reply.createdAt)!.short}` : ''}</span>
      <span className="chat-agent-spacer" />
      <StatusPill status={{ state: 'answered', replies: [] }} />
    </div>
    <div className="chat-agent-body">{renderText(reply.text)}</div>
  </div>;
}

/** The card itself: header, body, then a footer (waiting) or the replies (answered). */
function Card({ anchorId, head, body, record, hint, copyText, renderText, outgoing = false }: {
  anchorId: string; head: ReactNode; body: string; record?: AgentMessageRecord; hint?: ReactNode; copyText: string;
  renderText: (text: string) => ReactNode; outgoing?: boolean;
}) {
  const { byRef, panelId } = useContext(AgentMessagesContext);
  const status = record ? messageStatus(record, byRef) : undefined;
  return <div className="chat-agent-row" data-outgoing={outgoing}>
    <div className="chat-agent-card" data-pane-part="chat-message" data-anchor-id={anchorId} data-testid="agent-message-card" data-ref={record?.ref} data-state={status?.state}>
      <div className="chat-agent-head">{head}</div>
      <div className="chat-agent-body">{renderText(body)}</div>
      {status && status.state !== 'answered' && <div className="chat-agent-foot"><StatusPill status={status} />{status.state === 'waiting' && hint}</div>}
      {status?.state === 'answered' && status.replies.map(reply => <ReplySection key={reply.ref} reply={reply} panelId={panelId} renderText={renderText} />)}
    </div>
    <div className="chat-message-actions"><ChatCopyButton label="Copy message" text={() => copyText} /></div>
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
  return <Card anchorId={anchorId} body={line.body} record={record} hint={hint} copyText={text} renderText={renderText} head={<>
    <Avatar sender={line.sender} />
    <span className="chat-agent-name">{line.sender.name}</span>
    {line.sender.kind && <span className="chat-agent-kind">{line.sender.kind}</span>}
    <span className="chat-agent-spacer" />
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
    return <Card key={record.ref} outgoing anchorId={`agent-message:${record.ref}`} body={record.text} record={record} copyText={record.text} renderText={renderText} head={<>
      <Avatar sender={senderOfName(record.sender.name)} />
      <span className="chat-agent-kind">Sent to</span>
      <span className="chat-agent-name">{to.name}</span>
      <span className="chat-agent-spacer" />
      <Ref value={record.ref} />
      <Time iso={record.createdAt} />
    </>} />;
  })}</>;
}

/** A reply arriving here: when its message's card is in this chat the reply shows there, so this is one line that jumps to it. */
function ReplyArrival({ line, anchorId, startedAt, text, renderText }: { line: Extract<ChatAgentLine, { type: 'reply' }>; anchorId: string; startedAt?: string; text: string; renderText: (text: string) => ReactNode }) {
  const { byRef, sentByTurn } = useContext(AgentMessagesContext);
  const shown = [...sentByTurn.values()].some(sent => sent.some(record => record.ref === line.replyTo));
  if (shown) {
    const jump = () => document.querySelector(`[data-anchor-id="agent-message:${CSS.escape(line.replyTo)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return <div className="chat-agent-arrival" data-pane-part="chat-message" data-anchor-id={anchorId} data-testid="agent-reply-arrival">
      <button type="button" className="chat-agent-jump" onClick={jump}><ArrowUp aria-hidden="true" />{line.sender.name} replied to {line.replyTo} above<Time iso={byRef.get(line.ref)?.createdAt ?? startedAt} /></button>
    </div>;
  }
  // Its message isn't in this chat (sent before a Switch to chat, or paged out): the reply is its own card.
  return <Card anchorId={anchorId} body={line.body} record={byRef.get(line.ref)} copyText={text} renderText={renderText} head={<>
    <Avatar sender={line.sender} />
    <span className="chat-agent-name">{line.sender.name}</span>
    <span className="chat-agent-kind">replied to</span>
    <Ref value={line.replyTo} />
    <span className="chat-agent-spacer" />
    <Time iso={byRef.get(line.ref)?.createdAt ?? startedAt} />
  </>} />;
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

/** A message Pane or another agent typed into this tab, drawn by what it is. */
export function AgentLineView({ line, anchorId, startedAt, text, renderText }: { line: ChatAgentLine; anchorId: string; startedAt?: string; text: string; renderText: (text: string) => ReactNode }) {
  switch (line.type) {
    case 'message': return <IncomingCard line={line} anchorId={anchorId} startedAt={startedAt} text={text} renderText={renderText} />;
    case 'reply': return <ReplyArrival line={line} anchorId={anchorId} startedAt={startedAt} text={text} renderText={renderText} />;
    case 'relayed': return <RelayedBubble line={line} anchorId={anchorId} text={text} title={messageTime(startedAt)?.full} />;
  }
}
