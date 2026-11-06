import React, { useEffect, useState } from 'react';
import { LogsView } from './LogsView';
import { LogsPanelState, ToolPanel } from '../../../../../shared/types/panels';
import { Square } from 'lucide-react';

interface LogsPanelProps {
  panel: ToolPanel;
  isActive: boolean;
}

const LogsPanel: React.FC<LogsPanelProps> = ({ panel, isActive }) => {
  const [isRunning, setIsRunning] = useState(false);
  // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
  const logsState = panel.state?.customState as LogsPanelState;
  
  // Set running state from panel state
  useEffect(() => {
    setIsRunning(logsState?.isRunning || false);
  }, [logsState?.isRunning]);
  
  const handleStop = async () => {
    try {
      await window.electronAPI.logs.stopScript(panel.id);
    } catch (error) {
      console.error('Failed to stop script:', error);
    }
  };
  
  // For now, we'll use the existing LogsView component
  // In a full implementation, we might create a more specialized view
  return (
    <div className="h-full flex flex-col bg-bg-primary">
      {/* Header with run status */}
      {logsState && (
        <div className="flex items-center justify-between px-4 py-2 bg-surface-secondary border-b border-border-primary">
          <div className="flex items-center gap-2">
            {isRunning ? (
              <>
                <div className="w-2 h-2 bg-status-success rounded-full animate-pulse" />
                <span className="text-sm text-text-secondary">Running: {logsState.command}</span>
              </>
            ) : (
              <>
                <div className="w-2 h-2 bg-text-tertiary rounded-full" />
                <span className="text-sm text-text-secondary">
                  {logsState.exitCode !== undefined 
                    ? `Exited with code ${logsState.exitCode}`
                    : 'Ready'}
                </span>
              </>
            )}
          </div>
          
          {isRunning && (
            <button
              onClick={handleStop}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-status-error text-text-on-status-error rounded hover:bg-status-error-hover transition-colors"
            >
              <Square className="w-3 h-3" />
              Stop
            </button>
          )}
        </div>
      )}
      
      {/* Use the existing LogsView for now */}
      {/* In a full refactor, we'd adapt LogsView to work with panel state */}
      <div className="flex-1 overflow-hidden">
        <LogsView 
          panelId={panel.id}
          sessionId={panel.sessionId}
          isVisible={isActive}
        />
      </div>
    </div>
  );
};

export default LogsPanel;
