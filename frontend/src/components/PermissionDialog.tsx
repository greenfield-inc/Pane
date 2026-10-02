import React, { useState, useEffect } from 'react';
import { Check, X, Shield, AlertTriangle, Code, Edit } from 'lucide-react';
import type { PanePermissionRequest } from '../../../shared/types/daemon';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { Textarea } from './ui/Textarea';

interface PermissionDialogProps {
  request: PanePermissionRequest | null;
  onRespond: (
    requestId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: PanePermissionRequest['input'],
    message?: string,
  ) => void;
  session?: { name: string };
}

const TOOL_DESCRIPTIONS = {
  Bash: 'Execute shell commands',
  Write: 'Write files to disk',
  Edit: 'Modify existing files',
  MultiEdit: 'Make multiple edits to a file',
  Delete: 'Delete files or directories',
  Move: 'Move or rename files',
  Read: 'Read file contents',
  Grep: 'Search file contents',
  WebFetch: 'Fetch content from the web',
  WebSearch: 'Search the web',
};

function getToolDescription(toolName: string): string {
  for (const [key, description] of Object.entries(TOOL_DESCRIPTIONS)) {
    if (toolName.includes(key)) return description;
  }
  return 'Perform an action';
}

export const PermissionDialog: React.FC<PermissionDialogProps> = ({ request, onRespond, session }) => {
  const [editMode, setEditMode] = useState(false);
  const [editedInput, setEditedInput] = useState('');

  useEffect(() => {
    if (request) {
      setEditedInput(JSON.stringify(request.input, null, 2));
      setEditMode(false);
    }
  }, [request]);

  if (!request) return null;

  const handleAllow = () => {
    let updatedInput = request.input;
    if (editMode) {
      try {
        updatedInput = JSON.parse(editedInput);
      } catch (error) {
        // If JSON parse fails, keep original input
        console.error('Invalid JSON in edited input:', error);
      }
    }
    onRespond(request.id, 'allow', updatedInput);
  };

  const handleDeny = () => {
    onRespond(request.id, 'deny', undefined, 'Permission denied by user');
  };

  const formatToolName = (toolName: string) => {
    // Remove mcp prefix if present
    if (toolName.startsWith('mcp__')) {
      return toolName.substring(5).replace(/__/g, ' → ');
    }
    return toolName;
  };

  const isHighRisk = (toolName: string) => {
    const highRiskTools = ['Bash', 'Delete', 'Write', 'Edit', 'MultiEdit'];
    return highRiskTools.some(tool => toolName.includes(tool));
  };

  const renderInputPreview = () => {
    const { input, toolName } = request;
    
    // Helper to safely get string value
    const getStringValue = (obj: PanePermissionRequest['input'], key: string): string | undefined =>
      decodeOptionalBoundary(obj[key], boundary.string);
    
    if (toolName.includes('Bash')) {
      const command = getStringValue(input, 'command');
      const description = getStringValue(input, 'description');
      
      return (
        <div className="select-text bg-surface-secondary p-3 rounded font-mono text-sm border border-border-primary">
          <div className="text-text-tertiary text-xs mb-1">Command:</div>
          <div className="text-text-primary">{command || 'No command specified'}</div>
          {description && (
            <>
              <div className="text-text-tertiary text-xs mt-2 mb-1">Description:</div>
              <div className="text-text-secondary">{description}</div>
            </>
          )}
        </div>
      );
    }
    
    if (toolName.includes('Write') || toolName.includes('Edit')) {
      const filePath = getStringValue(input, 'file_path') || getStringValue(input, 'path');
      const content = getStringValue(input, 'content');
      
      return (
        <div className="select-text bg-surface-secondary p-3 rounded font-mono text-sm border border-border-primary">
          <div className="text-text-tertiary text-xs mb-1">File Path:</div>
          <div className="text-text-primary">{filePath || 'No path specified'}</div>
          {content && (
            <>
              <div className="text-text-tertiary text-xs mt-2 mb-1">Content Preview:</div>
              <div className="text-text-secondary max-h-32 overflow-y-auto whitespace-pre-wrap">
                {content.length > 500 ? content.substring(0, 500) + '...' : content}
              </div>
            </>
          )}
        </div>
      );
    }
    
    // Default JSON view
    return (
      <div className="select-text bg-surface-secondary p-3 rounded font-mono text-sm border border-border-primary">
        <pre className="text-text-primary overflow-x-auto">{JSON.stringify(input, null, 2)}</pre>
      </div>
    );
  };

  return (
    <Modal isOpen={true} onClose={() => handleDeny()} size="lg" showCloseButton={false}>
      <ModalHeader
        title="Permission Required"
        icon={<Shield className={`w-6 h-6 ${isHighRisk(request.toolName) ? 'text-status-error' : 'text-status-warning'}`} />}
        description={<>Claude wants to {getToolDescription(request.toolName)} in session: {session?.name || request.sessionId}</>}
        onClose={() => handleDeny()}
      />
        
      <ModalBody className="space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Code className="w-4 h-4 text-text-tertiary" />
              <h3 className="text-sm font-medium text-text-secondary">Tool</h3>
              {isHighRisk(request.toolName) && (
                <span className="text-xs bg-status-error/20 text-status-error px-2 py-0.5 rounded">High Risk</span>
              )}
            </div>
            <p className="text-text-primary font-mono">{formatToolName(request.toolName)}</p>
          </div>
          
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-text-secondary">Input Parameters</h3>
              <button
                onClick={() => setEditMode(!editMode)}
                className="flex items-center gap-1 text-xs text-interactive hover:text-interactive-hover transition-colors"
              >
                <Edit className="w-3 h-3" />
                {editMode ? 'Preview' : 'Edit'}
              </button>
            </div>
            
            {editMode ? (
              <Textarea
                value={editedInput}
                onChange={(e) => setEditedInput(e.target.value)}
                className="font-mono text-sm h-48"
                spellCheck={false}
              />
            ) : (
              renderInputPreview()
            )}
          </div>
          
          {isHighRisk(request.toolName) && (
            <div className="bg-status-error/10 border border-status-error/30 rounded p-3">
              <div className="flex items-center gap-2 text-status-error">
                <AlertTriangle className="w-4 h-4" />
                <span className="text-sm font-medium">High Risk Action</span>
              </div>
              <p className="text-xs text-text-tertiary mt-1">
                This action could modify your system or files. Review carefully before approving.
              </p>
            </div>
          )}
      </ModalBody>
        
      <ModalFooter>
        <Button
          onClick={handleDeny}
          variant="secondary"
          icon={<X className="w-4 h-4" />}
        >
          Deny
        </Button>
        <Button
          onClick={handleAllow}
          variant="primary"
          icon={<Check className="w-4 h-4" />}
        >
          Allow
        </Button>
      </ModalFooter>
    </Modal>
  );
};
