import { memo, useState } from 'react';
import { AlertCircle, Brain, Check, ChevronDown, ChevronRight, Circle, CircleCheck, Eye, LoaderCircle, Pencil, Terminal, Wrench, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentChatPermission } from '../../../../shared/types/agentChat';
import { describeChatContent, permissionToolId } from '../../../../shared/agentChatPresentation';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { imageOf, stoppedText, turnSummary, type ChatStep, type ChatTurn, type PlanEntry, type StepGroup, type TurnItem } from '../../../../shared/chatTabPresentation';

export interface ChatTurnActions {
  /** Opens the file's diff in Pane's diff view. A diff never renders in the thread by itself. */
  onViewDiff?: (path: string) => void;
}

const Markdown = memo(({ text }: { text: string }) => <div className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>{text}</ReactMarkdown></div>);
Markdown.displayName = 'Markdown';

const VERBS = { explore: ['Exploring', 'Explored'], edit: ['Edit', 'Edited'], run: ['Run', 'Ran'], think: ['Thinking', 'Thought'], other: ['Using', 'Used'] } satisfies Record<ChatStep['kind'], [string, string]>;
const ICONS = { explore: Eye, edit: Pencil, run: Terminal, think: Brain, other: Wrench };

function groupState(group: StepGroup, waiting: Set<string>): 'waiting' | 'running' | 'failed' | 'done' {
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

function StepGroupRow({ group, waiting, actions }: { group: StepGroup; waiting: Set<string>; actions: ChatTurnActions }) {
  const state = groupState(group, waiting);
  const [open, setOpen] = useState(false);
  const single = group.steps.length === 1 ? group.steps[0] : undefined;
  const verb = VERBS[group.kind][state === 'running' || state === 'waiting' ? 0 : 1];
  const liveOutput = single?.kind === 'run' && state === 'running' && single.output;
  const expandable = group.kind !== 'edit' && (group.steps.length > 1 || !!single?.output || (group.kind === 'other' && single?.input !== undefined));
  return <div className="chat-step" data-kind={group.kind} data-state={state}>
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
  return <section className="chat-todo" aria-label="Agent's to-do list">
    <p className="chat-todo-title">To-do · {done} of {entries.length} done</p>
    <ul>{entries.map((entry, index) => <li key={index} data-status={entry.status}>
      <span className="chat-step-icon">{entry.status === 'completed' ? <CircleCheck aria-hidden="true" /> : entry.status === 'in_progress' ? <LoaderCircle aria-hidden="true" /> : <Circle aria-hidden="true" />}</span>
      <span>{entry.content}</span>
    </li>)}</ul>
  </section>;
}

function Item({ item, waiting, actions }: { item: TurnItem; waiting: Set<string>; actions: ChatTurnActions }) {
  switch (item.type) {
    case 'text': return <Markdown text={item.text} />;
    case 'thought': return <details className="chat-thought"><summary><Brain aria-hidden="true" />Thinking</summary><div className="whitespace-pre-wrap">{item.text}</div></details>;
    case 'image': return <img className="chat-image" alt="Image from the agent" src={`data:${item.mimeType};base64,${item.data}`} />;
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
  return picture ? <img className="chat-image" alt="Attached image" src={`data:${picture.mimeType};base64,${picture.data}`} /> : null;
}

function UserMessage({ turn }: { turn: ChatTurn }) {
  if (!turn.user) return null;
  return <div className="chat-user">{turn.user.parts.map((part, index) => part.type === 'text'
    ? <span key={index} className="whitespace-pre-wrap">{part.text}</span>
    : part.type === 'content' ? <UserImage key={index} content={part.content} /> : null)}</div>;
}

/**
 * One turn. In a quiet chat (the Session orchestrator, D-18) a running turn shows
 * only its current step and a finished turn folds its steps into one line.
 */
export const ChatTurnView = memo(function ChatTurnView({ turn, quiet, permissions, actions }: { turn: ChatTurn; quiet: boolean; permissions: AgentChatPermission[]; actions: ChatTurnActions }) {
  const [open, setOpen] = useState(false);
  const waiting = new Set(permissions.flatMap(permission => { const id = permissionToolId(permission); return id ? [id] : []; }));
  const hasSteps = turn.items.some(item => item.type === 'steps');
  const foldSteps = quiet && hasSteps;
  let foldShown = false;
  return <div className="chat-turn" data-running={turn.running}>
    <UserMessage turn={turn} />
    {turn.items.map(item => {
      if (item.type !== 'steps' || !foldSteps) return <Item key={item.id} item={item} waiting={waiting} actions={actions} />;
      if (turn.running) {
        if (foldShown || !turn.current) return null;
        foldShown = true;
        const current: StepGroup = { id: turn.current.id, kind: turn.current.kind, label: turn.current.path?.split(/[\\/]/).pop() ?? turn.current.title, added: turn.current.added ?? 0, removed: turn.current.removed ?? 0, steps: [turn.current] };
        return <div key="current" className="chat-steps"><StepGroupRow group={current} waiting={waiting} actions={actions} /></div>;
      }
      if (foldShown) return open ? <Item key={item.id} item={item} waiting={waiting} actions={actions} /> : null;
      foldShown = true;
      return <div key={item.id}>
        <button type="button" className="chat-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="chat-step-icon"><Check aria-hidden="true" /></span>
          <span>{turnSummary(turn)}</span>
          {open ? <ChevronDown className="chat-fold-chevron" /> : <ChevronRight className="chat-fold-chevron" />}
        </button>
        {open && <div className="chat-fold-body"><Item item={item} waiting={waiting} actions={actions} /></div>}
      </div>;
    })}
    {stoppedText(turn) && <p className="chat-turn-stopped">{stoppedText(turn)}</p>}
  </div>;
});
