// Native adaptation of assistant-ui's MIT thread/tool-fallback registry.
// Geometry follows its defaults; Pane supplies host permissions, diffs and theme.
import { MessagePrimitive, useAuiState, type DataMessagePartComponent, type ReasoningMessagePartComponent, type TextMessagePartComponent, type ToolCallMessagePartProps } from '@assistant-ui/react-native';
import * as Clipboard from 'expo-clipboard';
import { createContext, useContext, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { useMarkdown } from 'react-native-marked';

import { describeChatContent, permissionToolId } from '@shared/agentChatPresentation';
import type { AgentChatPermission } from '@shared/types/agentChat';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

import { monoFontFamily, useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { ChatButton } from './ChatButton';

export const NativePermissionContext = createContext<{ permissions: AgentChatPermission[]; disabled: boolean; answer: (permission: AgentChatPermission, optionId: string) => Promise<void> }>({ permissions: [], disabled: true, answer: async () => undefined });

const UserText: TextMessagePartComponent = ({ text }) => { const { chat } = useTheme(); return <Text selectable style={{ color: chat.foreground }}>{text}</Text>; };
const TextPart: TextMessagePartComponent = ({ text }) => {
  const theme = useTheme();
  const content = useMarkdown(text, { colorScheme: theme.scheme, styles: {
    text: { color: theme.chat.foreground, fontSize: 16, lineHeight: 26 },
    link: { color: theme.chat.foreground, textDecorationLine: 'underline' },
    codespan: { color: theme.chat.foreground, backgroundColor: theme.chat.muted, fontFamily: monoFontFamily },
    code: { backgroundColor: theme.chat.muted, borderRadius: 8, padding: 10 },
    codeText: { color: theme.chat.foreground, fontSize: 12, fontFamily: monoFontFamily },
    paragraph: { marginTop: 0, marginBottom: 12 },
  } });
  return <View>{content}</View>;
};
const ReasoningPart: ReasoningMessagePartComponent = ({ text }) => {
  const { chat } = useTheme();
  const [open, setOpen] = useState(false);
  return <View><Pressable testID="chat-reasoning" accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={styles.trigger}><Text variant="subhead" style={{ color: chat.mutedForeground }}>Reasoning</Text></Pressable>{open && <Text selectable style={{ color: chat.mutedForeground }}>{text}</Text>}</View>;
};

const DataPart: DataMessagePartComponent = ({ data }) => {
  const { chat } = useTheme();
  const [open, setOpen] = useState(false);
  const content = describeChatContent(decodeBoundary(data, boundary.json));
  return <View>
    <Pressable testID="chat-content-details" accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={styles.trigger}><Text variant="subhead" style={{ color: chat.mutedForeground }}>{content.label}</Text></Pressable>
    {open && <View style={styles.toolContent}>
      {content.uri && <Text selectable style={{ color: chat.foreground }}>{content.uri}</Text>}
      {content.text && <Text selectable style={{ color: chat.foreground }}>{content.text}</Text>}
      <Text selectable accessibilityLabel="Content details" style={[styles.code, { color: chat.foreground, backgroundColor: chat.muted }]}>{content.details}</Text>
    </View>}
  </View>;
};

export function PermissionChoices({ permissions }: { permissions: AgentChatPermission[] }) {
  const context = useContext(NativePermissionContext);
  const { chat } = useTheme();
  const [answering, setAnswering] = useState(false);
  return <View style={styles.choices}>{permissions.map(permission => <View key={permission.id} testID={`chat-permission-${permission.id}`} style={styles.choices}>
    <Text variant="callout" accessibilityLiveRegion="polite" style={{ color: chat.foreground }}>{permission.title}</Text>
    {permission.options.map(option => <ChatButton key={option.optionId} testID={`chat-permission-option-${option.optionId}`} title={option.name} primary={option.kind === 'allow_once'} disabled={context.disabled || answering} onPress={() => { setAnswering(true); void context.answer(permission, option.optionId).finally(() => setAnswering(false)); }} />)}
  </View>)}</View>;
}

function ToolPart({ toolCallId, toolName, args, result, isError }: ToolCallMessagePartProps) {
  const { chat, colors } = useTheme();
  const context = useContext(NativePermissionContext);
  const permissions = context.permissions.filter(permission => permissionToolId(permission) === toolCallId);
  const waiting = permissions.length > 0;
  const [expanded, setExpanded] = useState(isError ?? false);
  const open = waiting || expanded;
  const running = args.status === 'pending' || args.status === 'in_progress';
  const label = `${waiting ? 'Waiting on tool' : isError ? 'Failed tool' : running ? 'Running tool' : 'Used tool'}: ${toolName}`;
  const output = decodeOptionalBoundary(result, boundary.object({ output: boundary.json, content: boundary.array(boundary.json) }));
  return <Animated.View layout={LinearTransition.duration(150).reduceMotion(ReduceMotion.System)} style={[styles.tool, { backgroundColor: chat.card, borderColor: chat.border }]}>
    <Pressable testID={`chat-tool-${toolCallId}`} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={label} onPress={() => setExpanded(!expanded)} style={styles.trigger}>
      <Icon ios={waiting ? 'exclamationmark.circle' : isError ? 'xmark.circle' : running ? 'clock' : 'checkmark'} android={waiting ? 'error_outline' : isError ? 'cancel' : running ? 'schedule' : 'check'} size={16} color={chat.mutedForeground} />
      <Text variant="subhead" numberOfLines={1} ellipsizeMode="tail" style={[styles.flex, { minWidth: 0, color: chat.mutedForeground }]}>{label}</Text>
      <Icon ios={open ? 'chevron.down' : 'chevron.right'} android={open ? 'expand_more' : 'chevron_right'} size={16} color={chat.mutedForeground} />
    </Pressable>
    {open && <View style={styles.toolContent}>
      <Text selectable style={{ color: chat.foreground }}>{toolName}</Text>
      {args.input != null && <Text selectable style={[styles.code, { backgroundColor: chat.muted, color: chat.foreground }]}>{JSON.stringify(args.input, null, 2)}</Text>}
      <PermissionChoices permissions={permissions} />
      {output?.content.map((content, index) => {
        const diff = decodeOptionalBoundary(content, boundary.object({ type: boundary.literal('diff'), path: boundary.string, oldText: boundary.nullable(boundary.string), newText: boundary.string }));
        return diff ? <View key={index}><Text variant="callout" style={{ color: chat.foreground }}>{diff.path}</Text><Text selectable style={[styles.code, { color: colors.danger }]}>{diff.oldText}</Text><Text selectable style={[styles.code, { color: colors.success }]}>{diff.newText}</Text></View> : <Text key={index} selectable style={[styles.code, { color: chat.foreground }]}>{JSON.stringify(content, null, 2)}</Text>;
      })}
      {(output?.output != null || (!output && result !== undefined)) && <Text selectable style={[styles.code, { backgroundColor: chat.muted, color: chat.foreground }]}>{JSON.stringify(output?.output ?? result, null, 2)}</Text>}
    </View>}
  </Animated.View>;
}

export function ChatMessage() {
  const { chat } = useTheme();
  const message = useAuiState(state => state.message);
  const endsTurn = useAuiState(state => state.thread.messages[state.message.index + 1]?.role !== 'assistant');
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  const user = message.role === 'user';
  const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
  return <MessagePrimitive.Root style={[styles.message, user ? [styles.user, { backgroundColor: chat.muted }] : styles.assistant]}>
    <MessagePrimitive.Parts components={{ Text: user ? UserText : TextPart, Reasoning: ReasoningPart, tools: { Fallback: ToolPart }, data: { Fallback: DataPart } }} />
    {!user && endsTurn && !!text && <Pressable testID={`chat-copy-${message.id}`} accessibilityRole="button" accessibilityLabel={copied ? 'Copied message' : 'Copy message'} onPress={() => { void Clipboard.setStringAsync(text).then(() => setCopied(true)); }} style={styles.copy}><Icon ios={copied ? 'checkmark' : 'document.on.document'} android={copied ? 'check' : 'content_copy'} size={16} color={chat.mutedForeground} /></Pressable>}
  </MessagePrimitive.Root>;
}
const styles = StyleSheet.create({
  flex: { flex: 1 }, message: { marginBottom: 24 }, user: { alignSelf: 'flex-end', maxWidth: '85%', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 8 }, assistant: { paddingHorizontal: 8 },
  copy: { minWidth: 44, minHeight: 44, alignSelf: 'flex-start', alignItems: 'center', justifyContent: 'center' },
  tool: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 4 }, trigger: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  toolContent: { gap: 8, paddingLeft: 24 }, choices: { gap: 8 }, code: { fontFamily: monoFontFamily, fontSize: 12, lineHeight: 18, padding: 10, borderRadius: 8 },
});
