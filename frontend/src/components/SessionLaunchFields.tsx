import { CustomResumeFields } from './CustomResumeFields';
import type { CustomCommandResume } from '../../../shared/types/customCommandResume';
import { useId, useRef, useState } from 'react';
import type { AppConfig } from '../types/config';
import { Input } from './ui/Input';
import { Textarea } from './ui/Textarea';
import { Button } from './ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';

interface SessionLaunchFieldsProps {
  resume?: CustomCommandResume | null;
  onResumeChange?: (resume: CustomCommandResume | null) => void;
  command: string;
  profile: string;
  customCommands?: AppConfig['customCommands'];
  onCommandChange: (command: string) => void;
  onProfileChange: (profile: string) => void;
}

export function SessionLaunchFields({ resume, onResumeChange, command, profile, customCommands = [], onCommandChange, onProfileChange }: SessionLaunchFieldsProps) {
  const [editingProfile, setEditingProfile] = useState(false);
  const [draftProfile, setDraftProfile] = useState(profile);
  const selectId = useId();
  const commandInput = useRef<HTMLInputElement>(null);
  const [customSelected, setCustomSelected] = useState(false);
  const commands = customCommands.filter(item => item.name && item.command);
  const selectedIndex = commands.findIndex(item => item.command === command);

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={selectId} className="mb-2 block text-sm font-medium text-text-primary">Launch command</label>
        <select
          id={selectId}
          value={customSelected ? 'custom' : !command ? 'builtin' : selectedIndex >= 0 ? String(selectedIndex) : 'custom'}
          onChange={event => {
            const value = event.target.value;
            setCustomSelected(value === 'custom');
            if (value === 'custom') commandInput.current?.focus();
            if (value === 'builtin') { onCommandChange(''); onResumeChange?.(null); }
            else if (value !== 'custom') { onCommandChange(commands[Number(value)].command); onResumeChange?.(commands[Number(value)].resume ?? null); }
          }}
          className="w-full rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive"
        >
          <option value="builtin">Selected agent default</option>
          {commands.map((item, index) => <option key={`${index}-${item.name}`} value={index}>{item.name}</option>)}
          <option value="custom">Custom command</option>
        </select>
      </div>
      <Input
        ref={commandInput}
        label="Custom command and arguments"
        value={command}
        onChange={event => { setCustomSelected(false); onCommandChange(event.target.value); }}
        placeholder="claude --model sonnet"
        helperText="Leave empty to use the selected agent’s default command."
        fullWidth
      />
      {onResumeChange && <CustomResumeFields value={resume} onChange={onResumeChange} />}
      <div className="flex items-center justify-between gap-4 border-t border-border-primary pt-4">
        <div>
          <p className="text-sm font-medium text-text-primary">Session behavior</p>
          <p className="text-xs text-text-secondary">Instructions for how this Session should help.</p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={() => {
          setDraftProfile(profile);
          setEditingProfile(true);
        }}>Edit behavior…</Button>
      </div>
      <Modal isOpen={editingProfile} onClose={() => setEditingProfile(false)} size="lg" ariaLabel="Edit Session behavior">
        <ModalHeader title="Session behavior" className="shrink-0" />
        <ModalBody className="min-h-0 space-y-3">
          <p className="text-sm text-text-secondary">These instructions guide the agent when you send a message. The Session waits for you before starting work.</p>
          <Textarea
            label="Session behavior profile"
            value={draftProfile}
            onChange={event => setDraftProfile(event.target.value)}
            rows={12}
            className="max-h-[45vh]"
            autoFocus
            fullWidth
          />
        </ModalBody>
        <ModalFooter className="shrink-0">
          <Button type="button" variant="secondary" onClick={() => setEditingProfile(false)}>Back</Button>
          <Button type="button" onClick={() => {
            onProfileChange(draftProfile);
            setEditingProfile(false);
          }}>Save behavior</Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
