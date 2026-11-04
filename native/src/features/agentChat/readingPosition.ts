import type { LegendListState } from '@legendapp/list/react-native';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

export const MESSAGE_TOP_PADDING = 16;
export interface ChatReadingPosition {
  conversationId?: string;
  atBottom: boolean;
  anchor?: { messageId: string; withinItemOffset: number; fallbackIndex: number };
}

type Layout = Pick<LegendListState, 'data' | 'start' | 'scroll' | 'scrollLength' | 'contentLength' | 'positionAtIndex' | 'sizeAtIndex'>;

export function captureReadingPosition(conversationId: string, layout: Layout, ready: boolean): ChatReadingPosition | undefined {
  if (!ready || layout.start < 0 || layout.start >= layout.data.length) return;
  const row = decodeOptionalBoundary(layout.data[layout.start], boundary.object({ id: boundary.string }));
  const top = layout.positionAtIndex(layout.start);
  const size = layout.sizeAtIndex(layout.start);
  if (!row || ![top, size, layout.scroll, layout.scrollLength, layout.contentLength].every(Number.isFinite) || size <= 0 || layout.scrollLength <= 0) return;
  return {
    conversationId,
    atBottom: layout.contentLength - layout.scroll - layout.scrollLength < 32,
    anchor: { messageId: row.id, fallbackIndex: layout.start, withinItemOffset: Math.min(layout.scroll - top - MESSAGE_TOP_PADDING, size - 1) },
  };
}

export function resolveReadingPosition(position: ChatReadingPosition, conversationId: string, messages: readonly { id: string }[]) {
  if (position.conversationId !== conversationId || position.atBottom) return { atBottom: true };
  if (!messages.length) return { atBottom: false };
  const found = messages.findIndex(message => message.id === position.anchor?.messageId);
  const index = found < 0 ? Math.min(position.anchor?.fallbackIndex ?? 0, messages.length - 1) : found;
  return { atBottom: false, index: { index, viewPosition: 0, viewOffset: found < 0 ? 0 : -(position.anchor?.withinItemOffset ?? 0) } };
}
