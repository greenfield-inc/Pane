import { memo, useContext, useMemo, useState, type ComponentProps } from 'react';
import { ChatBlocksContext } from './chatRendering';
import { AlertCircle, Brain, ChevronDown, ChevronRight, Circle, CircleCheck, Eye, LoaderCircle, Pencil, Terminal, Wrench, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describeChatContent } from '../../../../shared/agentChatPresentation';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { imageOf, messageTime, planEntryKeys, stoppedText, turnDisplay, type WorkerNote, type ChatStep, type ChatTurn, type PlanEntry, type StepGroup, type TurnItem } from '../../../../shared/chatTabPresentation';
import { responseText, userMarkdown } from '../../../../shared/chatTabMarkdown';
import { ChatCopyButton } from './ChatCopyButton';

export interface ChatTurnActions {
  /** Opens the file's diff in Pane's diff view. A diff never renders in the thread by itself. */
  onViewDiff?: (path: string) => void;
  /** Opens a Session worker's Pane, at the given tab when one is named. */
  onOpenWorker?: (paneId: string, panelId?: string) => void;
}

/** A code block keeps its own copy button, for the code alone. */
function CodeBlock({ children, ...props }: React.ComponentProps<'pre'>) {
  const [element, setElement] = useState<HTMLPreElement | null>(null);
  return <div className="chat-code">
    <pre ref={setElement} {...props}>{children}</pre>
    <ChatCopyButton label="Copy code" className="chat-copy chat-code-copy" text={() => element?.innerText.replace(/\n$/, '') ?? ''} />
  </div>;
}

/** A hast node, as react-markdown hands it to a component: only what reading a code block needs. */
interface HastNode { type?: string; tagName?: string; value?: string; properties?: { className?: string[] | string }; children?: HastNode[] }
const hastText = (node: HastNode | undefined): string => node?.type === 'text' ? node.value ?? '' : (node?.children ?? []).map(hastText).join('');
function blockLanguage(node: HastNode | undefined): string | undefined {
  const code = node?.children?.find(child => child.tagName === 'code');
  const className = code?.properties?.className;
  const classes = Array.isArray(className) ? className : className ? [className] : [];
  const language = classes.find(name => name.startsWith('language-'));
  return language?.slice('language-'.length);
}

const Markdown = memo(({ text }: { text: string }) => {
  const { blocks } = useContext(ChatBlocksContext);
  const components = useMemo(() => ({
    a: ({ children, ...props }: ComponentProps<'a'>) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
    pre: ({ node, children, ...props }: ComponentProps<'pre'> & { node?: HastNode }) => {
      const language = blockLanguage(node);
      const render = language ? blocks?.[language] : undefined;
      return render ? <>{render(hastText(node).replace(/\n$/, ''))}</> : <CodeBlock {...props}>{children}</CodeBlock>;
    },
  }), [blocks]);
  return <div className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown></div>;
});
Markdown.displayName = 'Markdown';

const VERBS = { explore: ['Exploring', 'Explored'], edit: ['Edit', 'Edited'], run: ['Run', 'Ran'], think: ['Thinking', 'Thought'], other: ['Using', 'Used'] } satisfies Record<ChatStep['kind'], [string, string]>;
const ICONS = { explore: Eye, edit: Pencil, run: Terminal, think: Brain, other: Wrench };

function groupState(group: StepGroup, waiting: ReadonlySet<string>): 'waiting' | 'running' | 'failed' | 'done' {
  if (group.steps.some(step => waiting.has(step.id))) return 'waiting';
  if (group.steps.some(step => step.status === 'pending' || step.status === 'in_progress')) return 'running';
  if (group.steps.some(step => step.status === 'failed')) return 'failed';
  return 'done';
}

/** Swapping status icons share one fixed-size box, so the row never shifts. */
function StepIcon({ kind, state }: { kind: ChatStep['kind']; state: ReturnType<typeof groupState> }) {
  const Icon = state === 'waiting' ? AlertCircle : state === 'running' ? LoaderCircle : state === 'failed' ? XCircle : ICONS[kind];
  return <span className="chat-step-icon" data-state={state}><Icon aria-hidden="true" /></span>;
}

function Output({ text, live }: { text: string; live: boolean }) {
  const lines = text.split('\n');
  const shown = live ? lines.slice(-12).join('\n') : text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text;
  return <pre className="chat-step-output" aria-live={live ? 'polite' : undefined}>{shown}</pre>;
}

function StepGroupRow({ group, waiting, actions }: { group: StepGroup; waiting: ReadonlySet<string>; actions: ChatTurnActions }) {
  const state = groupState(group, waiting);
  const [open, setOpen] = useState(false);
  const single = group.steps.length === 1 ? group.steps[0] : undefined;
  const verb = VERBS[group.kind][state === 'running' || state === 'waiting' ? 0 : 1];
  const liveOutput = single?.kind === 'run' && state === 'running' && single.output;
  const expandable = group.kind !== 'edit' && (group.steps.length > 1 || !!single?.output || (group.kind === 'other' && single?.input !== undefined));
  return <div className="chat-step" data-anchor-id={group.id} data-kind={group.kind} data-state={state}>
    <div className="chat-step-line">
      <StepIcon kind={group.kind} state={state} />
      <span className="chat-step-verb">{verb}</span>
      {group.kind === 'run' && single
        ? <code className="chat-step-mono" title={single.command}>{single.command}</code>
        : group.kind === 'edit'
          ? <code className="chat-step-mono" title={group.steps[0].path}>{group.label}</code>
          : <span className="chat-step-label" title={group.label}>{group.label}</span>}
      {group.kind === 'run' && !single && group.detail && <span className="chat-step-detail" title={group.detail}>· {group.detail}</span>}
      {group.kind === 'edit' && (group.added > 0 || group.removed > 0) && <span className="chat-step-counts"><span className="chat-added">+{group.added}</span> <span className="chat-removed">−{group.removed}</span></span>}
      {group.kind === 'edit' && group.steps[0].path && actions.onViewDiff && <button type="button" className="chat-link" onClick={() => actions.onViewDiff!(group.steps[0].path!)}>View diff</button>}
      {state === 'waiting' && <span className="chat-step-detail">· waiting for you</span>}
      {state === 'failed' && <span className="chat-step-detail chat-removed">· failed</span>}
      {expandable && <button type="button" className="chat-step-toggle" aria-expanded={open} aria-label={open ? 'Hide steps' : 'Show steps'} onClick={() => setOpen(!open)}>{open ? <ChevronDown /> : <ChevronRight />}</button>}
    </div>
    {liveOutput && <Output text={liveOutput} live />}
    {open && <div className="chat-step-details">
      {group.steps.length > 1 && <ul>{group.steps.map(step => <li key={step.id}><span className="chat-step-mono">{step.kind === 'run' ? step.command : step.path ?? step.title}</span>{step.status === 'failed' && <span className="chat-removed"> · failed</span>}</li>)}</ul>}
      {single?.output && <Output text={single.output} live={false} />}
      {single && !single.output && single.input !== undefined && <pre className="chat-step-output">{JSON.stringify(single.input, null, 2)}</pre>}
    </div>}
  </div>;
}

function TodoList({ entries }: { entries: PlanEntry[] }) {
  const done = entries.filter(entry => entry.status === 'completed').length;
  const keys = planEntryKeys(entries);
  return <section className="chat-todo" aria-label="Agent's to-do list">
    <p className="chat-todo-title">To-do · {done} of {entries.length} done</p>
    <ul>{entries.map((entry, position) => <li key={keys[position]} data-status={entry.status}>
      <span className="chat-step-icon">{entry.status === 'completed' ? <CircleCheck aria-hidden="true" /> : entry.status === 'in_progress' ? <LoaderCircle aria-hidden="true" /> : <Circle aria-hidden="true" />}</span>
      <span>{entry.content}</span>
    </li>)}</ul>
  </section>;
}

function Item({ item, waiting, actions }: { item: TurnItem; waiting: ReadonlySet<string>; actions: ChatTurnActions }) {
  switch (item.type) {
    case 'text': return <div data-anchor-id={item.id}><Markdown text={item.text} /></div>;
    case 'thought': return <details className="chat-thought"><summary><Brain aria-hidden="true" />Thinking</summary><div className="whitespace-pre-wrap">{item.text}</div></details>;
    case 'image': return <img className="chat-image" alt="Sent by the agent" src={`data:${item.mimeType};base64,${item.data}`} />;
    case 'plan': return <TodoList entries={item.entries} />;
    case 'steps': return <div className="chat-steps">{item.groups.map(group => <StepGroupRow key={group.id} group={group} waiting={waiting} actions={actions} />)}</div>;
    case 'content': {
      const content = describeChatContent(item.content);
      return <details className="chat-thought"><summary>{content.label}</summary>{content.uri && <p className="break-all">{content.uri}</p>}{content.text && <pre>{content.text}</pre>}<pre>{content.details}</pre></details>;
    }
  }
}

function UserImage({ content }: { content: JsonValue }) {
  const picture = imageOf(content);
  return picture ? <img className="chat-image" alt="Attached to your message" src={`data:${picture.mimeType};base64,${picture.data}`} /> : null;
}

function UserMessage({ turn }: { turn: ChatTurn }) {
  const { userMessage } = useContext(ChatBlocksContext);
  if (!turn.user) return null;
  const custom = userMessage?.(turn.user.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'));
  if (custom !== undefined) return <>{custom}</>;
  return <div className="chat-user-row" title={messageTime(turn.startedAt)?.full}>
    <div className="chat-user" data-anchor-id={turn.user.id}>{turn.user.parts.map((part, index) => part.type === 'text'
      ? <span key={`${turn.id}:${index}`} className="whitespace-pre-wrap">{part.text}</span>
      : part.type === 'content' ? <UserImage key={`${turn.id}:${index}`} content={part.content} /> : null)}</div>
    {userMarkdown(turn) && <div className="chat-message-actions"><ChatCopyButton label="Copy message" text={() => userMarkdown(turn)} /></div>}
  </div>;
}

/** A worker the latest turn has news of, as one compact line with Open (D-201). */
export function WorkerNoteLine({ note, onOpen }: { note: WorkerNote; onOpen?: (paneId: string) => void }) {
  return <p className="chat-worker-note" data-state={note.worker.state}>
    <span className="chat-worker-note-text" title={note.text}>{note.text}</span>
    {onOpen && note.worker.state !== 'missing' && <> · <button type="button" className="chat-link" onClick={() => onOpen(note.worker.paneId)} aria-label={`Open ${note.worker.name}`}>Open</button></>}
  </p>;
}

/**
 * One turn (D-192): the agent's text, with its activity folded into one row. While
 * the turn runs the row says what it's doing now; afterwards, how long it worked.
 */
export const ChatTurnView = memo(function ChatTurnView({ turn, waiting, actions, latest = false }: { turn: ChatTurn; waiting: ReadonlySet<string>; actions: ChatTurnActions; latest?: boolean }) {
  const [open, setOpen] = useState(false);
  // D-202: the latest turn says when it finished; every message shows its time on hover.
  const { before, after, activity, fold: row, ended } = turnDisplay(turn, { latest, waiting });
  // The icon box stays after the turn ends, so the label never shifts.
  const icon = <span className="chat-step-icon" data-state={row?.waiting ? 'waiting' : turn.running ? 'running' : 'done'}>
    {row?.waiting ? <AlertCircle aria-hidden="true" /> : turn.running ? <LoaderCircle aria-hidden="true" /> : null}
  </span>;
  const fold = row && <div key="fold" className="chat-fold-row" data-running={turn.running}>
    {activity.length > 0
      ? <button type="button" className="chat-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon}
        <span className="chat-fold-label" title={ended?.full ?? row.label}>{row.label}</span>
        {open ? <ChevronDown className="chat-fold-chevron" /> : <ChevronRight className="chat-fold-chevron" />}
      </button>
      : <p className="chat-fold">{icon}<span className="chat-fold-label">{row.label}</span></p>}
    {open && <div className="chat-fold-body">{activity.map(item => <Item key={item.id} item={item} waiting={waiting} actions={actions} />)}</div>}
  </div>;
  return <div className="chat-turn" data-anchor-id={turn.id} data-running={turn.running}>
    <UserMessage turn={turn} />
    <div className="contents" title={ended?.full}>{before.map(item => <Item key={item.id} item={item} waiting={waiting} actions={actions} />)}</div>
    {fold}
    <div className="contents" title={ended?.full}>{after.map(item => <Item key={item.id} item={item} waiting={waiting} actions={actions} />)}</div>
    {!turn.running && (responseText(turn) || (latest && !activity.length && ended)) && <div className="chat-message-actions chat-response-actions">
      {responseText(turn) && <ChatCopyButton label="Copy response" text={() => responseText(turn)} />}
      {latest && !activity.length && ended && <span className="chat-turn-time" title={ended.full}>{ended.short}</span>}
    </div>}
    {stoppedText(turn) && <p className="chat-turn-stopped">{stoppedText(turn)}</p>}
  </div>;
});
