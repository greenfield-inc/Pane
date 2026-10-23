// Adapted from assistant-ui's minimal thread.aui.tsx and tool-fallback.aui.tsx
// at a24d074. MIT license: assistant-ui.LICENSE. Host permissions and diffs are
// Pane adapters; tools are never executed in this presentation layer.
import { useContext, useState } from 'react';
import { ActionBarPrimitive, AuiIf, MessagePrimitive, useAuiState, type DataMessagePartComponent, type ReasoningMessagePartComponent, type TextMessagePartComponent, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { AlertCircle, Check, ChevronDown, Copy, LoaderCircle, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { ChatPermissionContext } from './chatPermissionContext';
import { describeChatContent, permissionToolId } from '../../../../shared/agentChatPresentation';
import { AgentChatPermissions } from './AgentChatPermissions';

const UserText: TextMessagePartComponent = ({ text }) => <span className="whitespace-pre-wrap">{text}</span>;
const TextPart: TextMessagePartComponent = ({ text }) => <div className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>{text}</ReactMarkdown></div>;
const ReasoningPart: ReasoningMessagePartComponent = ({ text }) => <details className="chat-tool"><summary className="chat-tool-trigger"><span>Reasoning</span><ChevronDown className="chat-tool-chevron" /></summary><div className="chat-tool-content whitespace-pre-wrap">{text}</div></details>;
const DataPart: DataMessagePartComponent = ({ data }) => {
  const content = describeChatContent(decodeBoundary(data, boundary.json));
  return <details className="chat-tool"><summary className="chat-tool-trigger"><span>{content.label}</span><ChevronDown className="chat-tool-chevron" /></summary><div className="chat-tool-content">
    {content.uri && <p className="break-all">{content.uri}</p>}
    {content.text && <pre>{content.text}</pre>}
    <pre aria-label="Content details">{content.details}</pre>
  </div></details>;
};

function ToolPart({ toolCallId, toolName, args, result, isError }: ToolCallMessagePartProps) {
  const permissionContext = useContext(ChatPermissionContext);
  const permissions = permissionContext.permissions.filter(permission => permissionToolId(permission) === toolCallId);
  const waiting = permissions.length > 0;
  const [expanded, setExpanded] = useState(isError ?? false);
  const running = args.status === 'pending' || args.status === 'in_progress';
  const label = `${waiting ? 'Waiting on tool' : isError ? 'Failed tool' : running ? 'Running tool' : 'Used tool'}: ${toolName}`;
  const Icon = waiting ? AlertCircle : isError ? XCircle : running ? LoaderCircle : Check;
  const output = decodeOptionalBoundary(result, boundary.object({ output: boundary.json, content: boundary.array(boundary.json) }));
  return <details className="chat-tool" data-chat-tool={toolCallId} open={waiting || expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="chat-tool-trigger"><Icon /><span title={label}>{label}</span><ChevronDown className="chat-tool-chevron" /></summary>
    {(waiting || expanded) && <div className="chat-tool-content">
      <p className="break-all">{toolName}</p>
      {args.input != null && <pre>{JSON.stringify(args.input, null, 2)}</pre>}
      <AgentChatPermissions {...permissionContext} permissions={permissions} inline />
      {output?.content.map((content, index) => {
        const diff = decodeOptionalBoundary(content, boundary.object({ type: boundary.literal('diff'), path: boundary.string, oldText: boundary.nullable(boundary.string), newText: boundary.string }));
        if (!diff) return <pre key={index}>{JSON.stringify(content, null, 2)}</pre>;
        return <div key={index}><p className="break-all font-medium">{diff.path}</p><pre aria-label="Before edit" className="text-status-error">{diff.oldText}</pre><pre aria-label="After edit" className="text-status-success">{diff.newText}</pre></div>;
      })}
      {(output?.output != null || (!output && result !== undefined)) && <div><p className="text-xs">Result:</p><pre>{JSON.stringify(output?.output ?? result, null, 2)}</pre></div>}
    </div>}
  </details>;
}

export function MessageRow() {
  const role = useAuiState(state => state.message.role);
  const endsTurn = useAuiState(state => state.thread.messages[state.message.index + 1]?.role !== 'assistant');
  return <MessagePrimitive.Root className="chat-message" data-role={role}>
    <div className={role === 'user' ? 'chat-user-content' : undefined}>
      <MessagePrimitive.Parts components={{ Text: role === 'user' ? UserText : TextPart, Reasoning: ReasoningPart, tools: { Fallback: ToolPart }, data: { Fallback: DataPart } }} />
    </div>
    {role === 'assistant' && endsTurn && <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="chat-actions">
      <ActionBarPrimitive.Copy className="chat-icon" aria-label="Copy message" title="Copy message">
        <AuiIf condition={state => state.message.isCopied}><Check className="h-4 w-4" /></AuiIf>
        <AuiIf condition={state => !state.message.isCopied}><Copy className="h-4 w-4" /></AuiIf>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>}
  </MessagePrimitive.Root>;
}
