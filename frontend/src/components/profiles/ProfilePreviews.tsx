import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { agentLabel } from '../../../../shared/agents';
import type { ProfileSubagentNode, ProfileSummary, ProfileTreeNode } from '../../../../shared/types/profileEditor';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { fileKey, useProfilesStore } from '../../stores/profilesStore';
import { profileDisplayName } from '../../utils/profileAvatar';
import { MarkdownPreview } from '../MarkdownPreview';
import { ProfileAvatar } from './ProfileAvatar';
import { SquareTerminal } from 'lucide-react';
import { TODOS_HEADER_BUTTON } from '../todos/todoStyles';
import { tabActionLabel, tabCommand, useTabPane } from './subagentTab';
import { LINK_MODE_TEXT, coverFacts, sandboxedHtml, splitFrontMatter, subagentLabel, subagentState, variantsText } from './profilePreview';

/**
 * The profile page's previews (T-63, build-6 feedback items 3 and 5): an HTML file as a page in a
 * sandboxed frame, Markdown formatted under its front-matter as a metadata header, YAML as
 * key/value metadata, and the cover Pane makes for a profile or subagent without a cover file.
 */

/** Pane's theme colours as a page's base style, read from the window's tokens. */
function themeCss(): string {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return `html{background:${token('--color-bg-primary')};color:${token('--color-text-primary')};font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:24px 32px}a{color:${token('--color-interactive')}}`;
}

/**
 * An HTML file as a page: no scripts (the frame's sandbox), nothing from the network (its policy).
 * A linked agent's custom cover shows how it runs above the page, as a generated cover does (F-8).
 */
export function HtmlPage({ html, title, subagent }: { html: string; title: string; subagent?: ProfileSubagentNode }) {
  const page = useMemo(() => sandboxedHtml(html, themeCss()), [html]);
  const frame = <iframe title={title} sandbox="" srcDoc={page} className="min-h-0 w-full flex-1 border-0" data-testid="profiles-html-preview" />;
  if (!subagent) return frame;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border-primary px-8 pb-4 pt-2"><LinkedAgentFacts subagent={subagent} /></div>
      {frame}
    </div>
  );
}

/** YAML (or front-matter) as data, parsed in main; undefined while it is read. */
function useParsedYaml(source: string | null): { data?: JsonValue; error?: string } | undefined {
  const parseYaml = useProfilesStore(state => state.parseYaml);
  const [parsed, setParsed] = useState<{ data?: JsonValue; error?: string }>();
  useEffect(() => {
    let live = true;
    setParsed(undefined);
    if (source !== null) void parseYaml(source).then(result => { if (live) setParsed(result); });
    return () => { live = false; };
  }, [parseYaml, source]);
  return parsed;
}

function isScalar(value: JsonValue): value is string | number | boolean | null {
  // Lists and mappings are objects; parsed YAML holds nothing else.
  return value === null || !(value instanceof Object);
}

function scalarText(value: string | number | boolean | null): string {
  return value === null ? '—' : String(value);
}

function Chip({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  const className = 'inline-flex h-6 items-center rounded-full border border-border-primary bg-surface-primary px-2 font-mono text-[12px] text-text-primary';
  return onClick
    ? <button type="button" onClick={onClick} className={`${className} hover:border-border-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive`}>{children}</button>
    : <span className={className}>{children}</span>;
}

/** One value: text, a row of chips for a list or a small mapping, or nested rows. */
function MetaValue({ value, depth }: { value: JsonValue; depth: number }) {
  if (isScalar(value)) return <span className="whitespace-pre-wrap break-words text-text-primary">{scalarText(value)}</span>;
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return <span className="flex flex-wrap gap-1.5">{value.map((item, index) => <Chip key={index}>{scalarText(item)}</Chip>)}</span>;
    return <span className="flex flex-col gap-1.5">{value.map((item, index) => <MetaValue key={index} value={item} depth={depth + 1} />)}</span>;
  }
  const entries = Object.entries(value);
  const scalars = entries.filter((entry): entry is [string, string | number | boolean | null] => isScalar(entry[1]));
  if (depth > 0 && scalars.length === entries.length) {
    return <span className="flex flex-wrap gap-1.5">{scalars.map(([key, item]) => <Chip key={key}>{key}: {scalarText(item)}</Chip>)}</span>;
  }
  return <MetaRows value={value} depth={depth + 1} />;
}

/** Key/value rows; a mapping value nests under its key. */
function MetaRows({ value, depth }: { value: Record<string, JsonValue>; depth: number }) {
  return (
    <div className="flex flex-col" data-testid="profiles-meta-rows">
      {Object.entries(value).map(([key, item]) => {
        const nested = !isScalar(item) && !Array.isArray(item) && !(depth > 0 && Object.values(item).every(isScalar));
        return nested ? (
          <div key={key} className="border-b border-border-primary py-1.5 last:border-b-0">
            <div className="font-mono text-[12.5px] font-semibold text-text-primary">{key}</div>
            <div className="pl-4"><MetaValue value={item} depth={depth} /></div>
          </div>
        ) : (
          <div key={key} className="grid grid-cols-[minmax(120px,180px)_1fr] items-start gap-3 border-b border-border-primary py-1.5 text-[13px] last:border-b-0">
            <span className="font-mono text-[12.5px] text-text-secondary">{key}</span>
            <MetaValue value={item} depth={depth} />
          </div>
        );
      })}
    </div>
  );
}

function YamlData({ parsed, source }: { parsed: { data?: JsonValue; error?: string } | undefined; source: string }) {
  if (!parsed) return null;
  if (parsed.error !== undefined) {
    return (
      <div>
        <p role="alert" className="mb-2 text-[12.5px] text-status-warning">This YAML doesn’t parse: {parsed.error}. Showing it as text.</p>
        <pre className="whitespace-pre-wrap font-mono text-[12.5px] text-text-primary">{source}</pre>
      </div>
    );
  }
  const data = parsed.data ?? null;
  if (isScalar(data) || Array.isArray(data)) return <MetaValue value={data} depth={0} />;
  return <MetaRows value={data} depth={0} />;
}

/** A YAML file as readable key/value metadata. */
export function YamlPreview({ source }: { source: string }) {
  const parsed = useParsedYaml(source);
  return <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" data-testid="profiles-yaml-preview"><YamlData parsed={parsed} source={source} /></div>;
}

/** A Markdown file formatted, with its front-matter as a metadata header above the body. */
export function MarkdownWithMeta({ source }: { source: string }) {
  const { frontMatter, body } = useMemo(() => splitFrontMatter(source), [source]);
  const parsed = useParsedYaml(frontMatter);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" data-testid="profiles-markdown-preview">
      {frontMatter !== null && (
        <div className="mb-4 rounded-lg border border-border-primary" data-testid="profiles-front-matter">
          <div className="border-b border-border-primary px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Metadata</div>
          <div className="px-3 py-1"><YamlData parsed={parsed} source={frontMatter} /></div>
        </div>
      )}
      <MarkdownPreview content={body} />
    </div>
  );
}

/** A file's content from the tab's copy, read once when shown. */
function useFileText(plugin: string, path: string | undefined): string | undefined {
  const key = path ? fileKey(plugin, path) : '';
  const saved = useProfilesStore(state => (path ? state.saved[key] : undefined));
  const readFile = useProfilesStore(state => state.readFile);
  useEffect(() => { if (path) readFile(plugin, path).catch(() => undefined); }, [path, plugin, readFile]);
  return saved;
}

function CoverSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-text-tertiary">{title}</h3>
      {children}
    </section>
  );
}

/** How a linked agent runs: its link and mode, a link that doesn't resolve, loops back or is `any`, and its command. */
function LinkedAgentFacts({ subagent, onOpenTab }: {
  subagent: ProfileSubagentNode;
  /** Opens a launch or process subagent in a tab (T-83 P4); absent, its command shows without the button. */
  onOpenTab?: (node: ProfileSubagentNode) => void;
}) {
  const state = subagentState(subagent);
  const pane = useTabPane();
  return (
    <>
      <p className="mt-3 text-[12.5px] text-text-tertiary" data-testid="profiles-cover-link">
        {subagent.any ? `${subagent.alias} · any agent in ${subagent.agent}` : `${subagent.alias} · ${subagent.agent}`} · {LINK_MODE_TEXT[subagent.mode].toLowerCase()}
      </p>
      {state === 'error' && (
        <p role="alert" className="mt-3 text-[13px] text-status-warning" data-testid="profiles-cover-error">Agent Farm couldn’t resolve this link: {subagent.error}</p>
      )}
      {state === 'cycle' && (
        <p className="mt-3 text-[13px] text-text-secondary" data-testid="profiles-cover-cycle">↻ This agent is already above on this path, so its files and links show there.</p>
      )}
      {state === 'any' && (
        <p className="mt-3 text-[13px] text-text-secondary" data-testid="profiles-cover-any">Its parent may start any agent in {subagent.agent}.</p>
      )}
      {subagent.command && (
        <CoverSection title="Run it on its own">
          <code className="block whitespace-pre-wrap break-all rounded-md border border-border-primary bg-surface-primary px-3 py-2 font-mono text-[12.5px] text-text-primary" data-testid="profiles-cover-command">{subagent.command}</code>
          {onOpenTab && tabCommand(subagent) && (
            <div className="mt-2 flex items-center gap-2">
              <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-cover-open-tab" title={tabActionLabel(subagent, pane)} onClick={() => onOpenTab(subagent)}>
                <SquareTerminal className="h-3.5 w-3.5" aria-hidden="true" />Open in a tab
              </button>
              <span className="truncate text-[12px] text-text-tertiary" data-testid="profiles-cover-tab-pane">
                {pane ? `in ${pane.name}` : 'Open a Pane first: the tab opens in the Pane you came from'}
              </span>
            </div>
          )}
        </CoverSection>
      )}
    </>
  );
}

/**
 * The cover Pane makes when a profile or subagent has no cover file: its title, description,
 * agent and model, what its identity says, and its subagents, skills and references.
 */
export function GeneratedCover({ plugin, profile, subagent, onOpenSubagent, onOpenTab }: {
  plugin: string;
  profile: ProfileSummary;
  /** The subagent this cover is for; absent for the profile itself. */
  subagent?: ProfileSubagentNode;
  onOpenSubagent: (id: string) => void;
  /** Opens a launch or process subagent in a tab (T-83 P4). */
  onOpenTab: (node: ProfileSubagentNode) => void;
}) {
  const identity = subagent ? subagent.identity : profile.entry || undefined;
  const text = useFileText(plugin, identity);
  const body = text === undefined ? '' : splitFrontMatter(text).body.trim();
  const tree: ProfileTreeNode[] = subagent ? subagent.children : profile.tree;
  const facts = coverFacts(tree);
  const title = subagent ? subagentLabel(subagent) : profile.title ?? profileDisplayName(profile.ref);
  const description = subagent ? subagent.description : profile.description;
  const harness = subagent ? subagent.harness : profile.harness;
  const model = subagent ? subagent.model : profile.model;
  const variants = variantsText(subagent ? subagent.variants : profile.variants, agentLabel);
  // A cover file belongs to an agent of this plugin (an `any` link or another plugin's agent has none here).
  const coverName = subagent ? (subagent.profile?.split('/')[1] ?? (subagent.identity ? subagent.agent.split('/').pop() : undefined)) : profile.name;
  const state = subagent ? subagentState(subagent) : 'agent';
  const runs = [variants ?? (harness ? agentLabel(harness) : undefined), model].filter(Boolean).join(' · ');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6" data-testid="profiles-generated-cover">
      <div className="flex items-center gap-4">
        <ProfileAvatar profileRef={subagent ? subagent.profile : profile.ref} agent={harness} size={56} />
        <div className="min-w-0">
          <h2 className="text-[22px] font-semibold leading-tight text-text-primary">{title}</h2>
          {description && <p className="mt-0.5 text-[14px] text-text-secondary">{description}</p>}
          {runs && <p className="mt-0.5 text-[12.5px] text-text-tertiary">{runs}</p>}
        </div>
      </div>
      {subagent && <LinkedAgentFacts subagent={subagent} onOpenTab={onOpenTab} />}
      {state === 'agent' && (
        <p className="mt-3 text-[12px] text-text-tertiary">
          Generated from the {subagent ? 'agent' : 'profile'}’s title, description, identity and subagents.{coverName ? ` Add covers/${coverName}.html to replace it.` : ''}
        </p>
      )}
      {body && (
        <CoverSection title="What it does">
          <MarkdownPreview content={body} />
        </CoverSection>
      )}
      {facts.subagents.length > 0 && (
        <CoverSection title="Subagents">
          <div className="flex flex-wrap gap-1.5">{facts.subagents.map(item => <Chip key={item.id} onClick={() => onOpenSubagent(item.id)}>{item.label}</Chip>)}</div>
        </CoverSection>
      )}
      {facts.skills.length > 0 && (
        <CoverSection title="Skills">
          <div className="flex flex-wrap gap-1.5">{facts.skills.map(item => <Chip key={item}>{item}</Chip>)}</div>
        </CoverSection>
      )}
      {facts.references.length > 0 && (
        <CoverSection title="References">
          <div className="flex flex-wrap gap-1.5">{facts.references.map(item => <Chip key={item}>{item}</Chip>)}</div>
        </CoverSection>
      )}
    </div>
  );
}
