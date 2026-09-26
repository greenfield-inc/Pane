import React from 'react';
import { API } from '../utils/api';
import { usePaneLogo } from '../hooks/usePaneLogo';
import { Modal, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';

interface WelcomeProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Welcome({ isOpen, onClose }: WelcomeProps) {
  const paneLogo = usePaneLogo();
  const [dontShowAgain, setDontShowAgain] = React.useState(false);

  React.useEffect(() => {
    const loadPreference = async () => {
      if (window.electronAPI?.preferences) {
        try {
          const value = await API.preferences.get('hide_welcome');
          setDontShowAgain(value === 'true');
        } catch (error) {
          console.error('[Welcome] Error loading preference:', error);
        }
      }
    };
    loadPreference();
  }, []);

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" ariaLabel="Welcome to Pane">
      <div className="px-6 pt-6 pb-2 flex flex-col items-start text-left">
        <img src={paneLogo} alt="Pane" className="h-12 w-12 mb-4" />
        <h1 className="text-lg font-semibold text-text-primary">Welcome to Pane</h1>
        <p className="text-sm text-text-tertiary mt-1">
          Run multiple agentic coding sessions in parallel, each in its own git worktree.
        </p>
        <p className="text-xs text-text-quaternary mt-3">
          Make sure your CLI tool (Claude Code, Codex, etc.) is installed and authenticated.
        </p>
      </div>

      <ModalFooter className="flex justify-between items-center">
        <Button
          onClick={async () => {
            const newValue = !dontShowAgain;
            setDontShowAgain(newValue);
            if (window.electronAPI?.preferences) {
              try {
                await API.preferences.set('hide_welcome', newValue ? 'true' : 'false');
              } catch (error) {
                console.error('[Welcome] Error setting preference:', error);
              }
            }
            if (newValue) {
              onClose();
            }
          }}
          variant={dontShowAgain ? "secondary" : "ghost"}
          size="sm"
        >
          {dontShowAgain ? "Will hide on next launch" : "Don't show this again"}
        </Button>
        <Button
          onClick={onClose}
          variant="primary"
        >
          Get Started
        </Button>
      </ModalFooter>
    </Modal>
  );
}
