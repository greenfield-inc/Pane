import fs from 'node:fs';
import { boundary, type BoundarySchema } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon } from './daemonClient';
import { RunpaneError } from './errors';

// The CLI's copy of the agent-to-agent message wire contract in shared/types/agentMessages.ts, which this package cannot import (T-104).

interface MessageParty {
  panelId: string | null;
  paneId: string | null;
  sessionId: string | null;
  name: string;
  orchestrator: boolean;
}

interface AgentMessage {
  ref: string;
  number: number;
  kind: 'message' | 'reply';
  replyTo: string | null;
  sender: MessageParty;
  receiver: MessageParty;
  text: string;
  state: 'sending' | 'queued' | 'delivered' | 'answered' | 'undelivered';
  deliveredVia: 'tab' | 'call' | null;
  undeliveredReason: string | null;
  replies: string[];
  createdAt: string;
  deliveredAt: string | null;
  answeredAt: string | null;
}

interface ReplyResult { ok: true; reply: AgentMessage; delivery: 'delivered' | 'queued' | 'undelivered'; next?: string }
interface MessageListResult { ok: true; messages: AgentMessage[] }
interface MessageShowResult { ok: true; message: AgentMessage; replies: AgentMessage[] }
interface MessageWaitResult { ok: boolean; message: string; outcome: 'reply' | 'timeout'; reply?: AgentMessage; next?: string }
interface MessageWaitRequest { message: string; timeoutMs?: number }
interface MessageListRequest { panelId?: string; all?: boolean; limit?: number; callerPanelId?: string }

const nullableString = boundary.nullable(boundary.string);
const partySchema: BoundarySchema<MessageParty> = boundary.object({
  panelId: nullableString, paneId: nullableString, sessionId: nullableString, name: boundary.string, orchestrator: boundary.boolean,
});
const messageSchema: BoundarySchema<AgentMessage> = boundary.object({
  ref: boundary.string, number: boundary.number, kind: boundary.enumeration('message', 'reply'), replyTo: nullableString,
  sender: partySchema, receiver: partySchema, text: boundary.string,
  state: boundary.enumeration('sending', 'queued', 'delivered', 'answered', 'undelivered'),
  deliveredVia: boundary.nullable(boundary.enumeration('tab', 'call')), undeliveredReason: nullableString,
  replies: boundary.array(boundary.string), createdAt: boundary.string, deliveredAt: nullableString, answeredAt: nullableString,
});
const replyResultSchema: BoundarySchema<ReplyResult> = boundary.object({
  ok: boundary.literal(true), reply: messageSchema, delivery: boundary.enumeration('delivered', 'queued', 'undelivered'), next: boundary.optional(boundary.string),
});
const listResultSchema: BoundarySchema<MessageListResult> = boundary.object({ ok: boundary.literal(true), messages: boundary.array(messageSchema) });
const showResultSchema: BoundarySchema<MessageShowResult> = boundary.object({ ok: boundary.literal(true), message: messageSchema, replies: boundary.array(messageSchema) });
const waitResultSchema: BoundarySchema<MessageWaitResult> = boundary.object({
  ok: boundary.boolean, message: boundary.string, outcome: boundary.enumeration('reply', 'timeout'), reply: boundary.optional(messageSchema), next: boundary.optional(boundary.string),
});

const MESSAGE_REF_PATTERN = /^\s*(?:[mM]-?)?([0-9]+)\s*$/u;
const LIST_NEXT = 'Copy the id from the message\'s reply line, or see recent ones with `runpane messages list`.';
/** Exit code for a wait that ran out, as `--wait` uses. */
const TIMEOUT_EXIT = 124;

function invalid(message: string, next: string): RunpaneError {
  return new RunpaneError('ERR_RUNPANE_INVALID_ARGUMENT', `${message} Nothing was sent.`, next);
}

/** "M-12", "m12" or "12" as "M-12". */
function messageRefFrom(parsed: ParsedArgs): string {
  const word = parsed.messageArgs?.[0];
  if (!word) throw invalid(`runpane ${parsed.command} needs the message id, such as M-12.`, LIST_NEXT);
  const match = MESSAGE_REF_PATTERN.exec(word);
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw invalid(`"${word}" is not a message id; a message id is M-12.`, LIST_NEXT);
  return `M-${number}`;
}

function onlyMessageRef(parsed: ParsedArgs): string {
  const ref = messageRefFrom(parsed);
  const extra = parsed.messageArgs?.slice(1) ?? [];
  if (extra.length > 0) throw invalid(`runpane ${parsed.command} takes one message id, but also got: ${extra.join(' ')}.`, `Run runpane ${parsed.command} ${ref}.`);
  return ref;
}

function replyText(parsed: ParsedArgs, ref: string): string {
  const words = parsed.messageArgs?.slice(1) ?? [];
  if (parsed.panelInputFile !== undefined) {
    if (words.length > 0) throw invalid('Pass the reply as text or with --input-file, not both.', `Run runpane reply ${ref} "…" or runpane reply ${ref} --input-file <path>.`);
    return parsed.panelInputFile === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(parsed.panelInputFile, 'utf8');
  }
  const text = words.join(' ').trim();
  if (!text) throw invalid(`runpane reply needs the reply after the message id, such as \`runpane reply ${ref} "Yes, until Friday."\`.`, 'Pass the reply in quotes after the message id, or use --input-file.');
  return text;
}

function callerFields(): { callerPanelId?: string } {
  const panelId = process.env.PANE_PANEL_ID?.trim();
  return panelId ? { callerPanelId: panelId } : {};
}

function printJson(value: ReplyResult | MessageListResult | MessageShowResult | MessageWaitResult): void {
  console.log(JSON.stringify(value, null, 2));
}

function describe(message: AgentMessage): string {
  const via = message.state === 'delivered' && message.deliveredVia === 'call' ? ' (to the waiting call)' : '';
  const why = message.state === 'undelivered' && message.undeliveredReason ? `: ${message.undeliveredReason}` : '';
  const replyTo = message.replyTo ? ` reply to ${message.replyTo}` : '';
  const replies = message.replies.length > 0 ? ` · replies ${message.replies.join(', ')}` : '';
  return `${message.ref}${replyTo} ${message.sender.name} → ${message.receiver.name} · ${message.state}${via}${why}${replies}\n  ${message.text.split('\n')[0]}`;
}

/** `--await-reply` and `runpane messages wait`: block until the reply comes, print it, exit 0; 124 after --timeout. */
export async function waitForMessageReply(parsed: ParsedArgs, ref: string): Promise<number> {
  const request: MessageWaitRequest = { message: ref };
  if (parsed.waitTimeoutMs) request.timeoutMs = parsed.waitTimeoutMs;
  const result = await invokeDaemon('runpane:messages:wait', [request], waitResultSchema, { paneDir: parsed.paneDir, timeoutMs: Infinity });
  if (parsed.json) printJson(result);
  else if (result.reply) console.log(`reply: ${ref} → "${result.reply.text}" (from ${result.reply.sender.name}) [${result.reply.ref}]`);
  else console.log(`No reply to ${ref} yet.${result.next ? ` ${result.next}` : ''}`);
  return result.outcome === 'reply' ? 0 : TIMEOUT_EXIT;
}

export async function runMessages(parsed: ParsedArgs): Promise<number> {
  switch (parsed.command) {
    case 'reply': {
      const ref = messageRefFrom(parsed);
      const result = await invokeDaemon('runpane:reply', [{ message: ref, text: replyText(parsed, ref), ...callerFields() }], replyResultSchema, { paneDir: parsed.paneDir });
      if (parsed.json) printJson(result);
      else {
        const where = result.delivery === 'delivered' ? 'Delivered' : result.delivery === 'queued' ? 'Queued' : 'Could not deliver';
        console.log(`${where} ${result.reply.ref}, the reply to ${ref}, to ${result.reply.receiver.name}.`);
        if (result.next) console.log(`Next: ${result.next}`);
      }
      return result.delivery === 'undelivered' ? 1 : 0;
    }
    case 'messages list': {
      const request: MessageListRequest = { ...callerFields() };
      if (parsed.panelId !== undefined) request.panelId = parsed.panelId;
      if (parsed.all) request.all = true;
      if (parsed.limit !== undefined) request.limit = parsed.limit;
      const result = await invokeDaemon('runpane:messages:list', [request], listResultSchema, { paneDir: parsed.paneDir });
      if (parsed.json) printJson(result);
      else console.log(result.messages.length === 0 ? 'No messages.' : result.messages.map(describe).join('\n'));
      return 0;
    }
    case 'messages show': {
      const result = await invokeDaemon('runpane:messages:show', [{ message: onlyMessageRef(parsed) }], showResultSchema, { paneDir: parsed.paneDir });
      if (parsed.json) printJson(result);
      else console.log([describe(result.message), ...result.replies.map(describe)].join('\n'));
      return 0;
    }
    case 'messages wait':
      return waitForMessageReply(parsed, onlyMessageRef(parsed));
    default:
      throw new Error(`runMessages does not handle ${parsed.command}.`);
  }
}
