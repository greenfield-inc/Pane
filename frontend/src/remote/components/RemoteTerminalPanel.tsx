import { AgentPanelSurface } from '../../components/agentChat/AgentPanelSurface';
import type { ToolPanel } from '../../../../shared/types/panels';
import type {
  RemotePaneConnectionStatus,
  RemotePwaTerminalShortcut,
  RemotePwaVoiceTranscriptionAffordance,
} from '../../../../shared/types/remoteDaemon';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';
import { useRemoteTerminal } from '../hooks/useRemoteTerminal';
import { RemoteTerminalInputBar } from './RemoteTerminalInputBar';
import { RemoteTerminalScrollJoystick } from './RemoteTerminalScrollJoystick';

interface RemoteTerminalPanelProps {
  adapter: RemoteRuntimeAdapter;
  panel: ToolPanel;
  sessionId: string;
  connectionStatus: RemotePaneConnectionStatus;
  /** Undefined until the host reports its Chat flag. */
  chatEnabled?: boolean;
  shortcuts: RemotePwaTerminalShortcut[];
  voiceTranscription: RemotePwaVoiceTranscriptionAffordance;
  shortcutsLoading?: boolean;
  onRefreshShortcuts: () => void;
}

export function RemoteTerminalPanel(props: RemoteTerminalPanelProps) {
  return <AgentPanelSurface panel={props.panel} client={props.adapter.agentChat} connected={props.connectionStatus === 'connected'} chatEnabled={props.chatEnabled}><NativeRemoteTerminalPanel {...props} /></AgentPanelSurface>;
}

function NativeRemoteTerminalPanel({
  adapter,
  panel,
  sessionId,
  connectionStatus,
  shortcuts,
  voiceTranscription,
  shortcutsLoading = false,
  onRefreshShortcuts,
}: RemoteTerminalPanelProps) {
  const {
    containerRef,
    statusText,
    focusTerminal,
    sendInput,
    resetTerminal,
    scrollLines,
    scrollToBottom,
  } = useRemoteTerminal({
    adapter,
    panel,
    sessionId,
    connectionStatus,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#010409]">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={containerRef} className="absolute inset-x-2 bottom-0 top-2 overflow-hidden" />
        {statusText !== 'Connected' && (
          <div className="pointer-events-none absolute right-3 top-3 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
            {statusText}
          </div>
        )}
        <RemoteTerminalScrollJoystick
          disabled={connectionStatus !== 'connected'}
          onScrollLines={scrollLines}
          onScrollToBottom={scrollToBottom}
        />
      </div>
      <RemoteTerminalInputBar
        shortcuts={shortcuts}
        shortcutsLoading={shortcutsLoading}
        voiceTranscription={voiceTranscription}
        disabled={connectionStatus !== 'connected'}
        onOpenShortcuts={onRefreshShortcuts}
        onResetTerminal={resetTerminal}
        onTranscribeAudio={(request) => adapter.transcribeVoice(request)}
        onCreateStreamingSocket={() => adapter.createDeepgramStreamingSocket()}
        onGetDeepgramToken={() => adapter.getDeepgramStreamingToken()}
        onFinalizeStreamingAudio={(request) => adapter.finalizeStreamingVoice(request)}
        onSendInput={async (data) => {
          await sendInput(data);
          window.requestAnimationFrame(focusTerminal);
        }}
      />
    </div>
  );
}
