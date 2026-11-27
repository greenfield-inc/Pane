/**
 * Hold R2 to dictate on desktop: the same host dictation the phone and the
 * web client use (useVoiceDictation over this machine's voice:* commands).
 * The words go into "the box": the focused chat composer, search field or
 * answer box, or a terminal agent's input line as a paste with no Enter.
 * Y sends.
 */
import { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import type {
  VoiceDeepgramTokenResult,
  VoiceStreamingFinalizeRequest,
  VoiceTranscriptionMode,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from '../../../shared/types/voiceTranscription';
import type { RemotePwaAffordances } from '../../../shared/types/remoteDaemon';
import { useVoiceDictation } from '../hooks/useVoiceDictation';
import { requestOpenSettings } from '../utils/openSettings';
import { focusedControllerTarget, type ControllerTarget } from './controllerTargets';
import { isTerminalInput } from './controllerFocus';
import { isMac } from '../utils/platformUtils';

const PROBLEM_SHOWN_MS = 8000;

type VoiceAffordance = Pick<RemotePwaAffordances['voiceTranscription'], 'availableModes' | 'defaultMode'>;

/** Where the words go, decided when R2 goes down so a focus change mid-sentence doesn't move them. */
type DictationTarget = { kind: 'target'; target: ControllerTarget } | { kind: 'field'; field: HTMLInputElement | HTMLTextAreaElement };

function isTextField(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled && !isTerminalInput(element);
  return element instanceof HTMLInputElement && ['text', 'search', ''].includes(element.type) && !element.readOnly && !element.disabled;
}

function pickTarget(): DictationTarget | null {
  const active = document.activeElement;
  // A text field other than a chat composer (search, an answer box) takes the words itself.
  if (isTextField(active) && !active.hasAttribute('data-chat-composer')) return { kind: 'field', field: active };
  const target = focusedControllerTarget();
  return target ? { kind: 'target', target } : null;
}

/** Adds the words to a React-controlled field the way typing would, so its onChange runs. */
function appendToField(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const current = field.value.trimEnd();
  const next = current ? `${current} ${text}` : text;
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, next);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** What to do about a microphone error, by OS. */
function microphoneProblem(message: string): string {
  if (/denied|not allowed|permission/i.test(message)) {
    return isMac()
      ? 'Pane can\'t use the microphone. Allow Pane in System Settings › Privacy & Security › Microphone, then hold again.'
      : 'The microphone is blocked. Allow desktop apps to use it in your system\'s privacy settings, then hold again.';
  }
  if (/not found|no device|could not start|notreadable|requested device/i.test(message)) {
    return 'No microphone is available. Connect one, or check that no other app holds it, then hold again.';
  }
  return message;
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.electronAPI.invoke(channel, ...args);
}

export interface ControllerDictation {
  start(): void;
  stop(): void;
  toggle(): void;
  listening: boolean;
  finishing: boolean;
  preview: string;
  problem: { text: string; settings: boolean } | null;
  dismiss(): void;
}

export function useControllerDictation(): ControllerDictation {
  const [affordance, setAffordance] = useState<VoiceAffordance | null>(null);
  const [problem, setProblem] = useState<ControllerDictation['problem']>(null);
  const target = useRef<DictationTarget | null>(null);
  const wantStart = useRef(false);
  /** Recording is opening (microphone, key, socket); a release now is kept until it has opened. */
  const starting = useRef(false);
  const releasedWhileStarting = useRef(false);
  const [stopOnceOpen, setStopOnceOpen] = useState(false);
  const mode: VoiceTranscriptionMode = affordance?.defaultMode ?? 'streaming';

  const voice = useVoiceDictation({
    mode,
    onTranscript: text => {
      const into = target.current;
      if (!text.trim() || !into) return;
      if (into.kind === 'field') appendToField(into.field, text.trim());
      else into.target.insertText(text.trim());
    },
    onTranscribeAudio: (request: VoiceTranscriptionRequest) => invoke<VoiceTranscriptionResult>('voice:transcribe', request),
    onGetDeepgramToken: () => invoke<VoiceDeepgramTokenResult>('voice:deepgram-token'),
    onFinalizeStreamingAudio: (request: VoiceStreamingFinalizeRequest) => invoke<VoiceTranscriptionResult>('voice:finalize-streaming', request),
  });
  const voiceRef = useRef(voice);
  useEffect(() => { voiceRef.current = voice; });

  useEffect(() => {
    if (voice.error) setProblem({ text: microphoneProblem(voice.error), settings: false });
  }, [voice.error]);

  // A pad has no pointer for Dismiss: the note clears itself after a while.
  useEffect(() => {
    if (!problem) return;
    const timer = window.setTimeout(() => setProblem(null), PROBLEM_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [problem]);

  const begin = () => {
    target.current = pickTarget();
    if (!target.current) {
      setProblem({ text: 'Focus a chat, a terminal agent or a text box first, then hold again.', settings: false });
      return;
    }
    setProblem(null);
    starting.current = true;
    releasedWhileStarting.current = false;
    void voiceRef.current.start().finally(() => {
      starting.current = false;
      if (releasedWhileStarting.current) setStopOnceOpen(true);
    });
  };

  // R2 came up (or the window lost focus) while the microphone was opening: stop it now it is open.
  useEffect(() => {
    if (!stopOnceOpen) return;
    setStopOnceOpen(false);
    releasedWhileStarting.current = false;
    if (voice.isRecording) void voice.stop();
  }, [stopOnceOpen, voice]);

  // Once the voice keys are known (read on the first hold), a hold that was waiting starts.
  useEffect(() => {
    if (!affordance || !wantStart.current) return;
    wantStart.current = false;
    if (affordance.availableModes.length === 0) {
      setProblem({ text: 'Dictation needs a Deepgram or fal key. Add one in Settings › Integrations.', settings: true });
      return;
    }
    begin();
  }, [affordance]);

  const start = () => {
    if (voiceRef.current.isRecording || starting.current) return;
    // A missing key is read again, so a key added since the last hold is found.
    if (!affordance || affordance.availableModes.length === 0) {
      wantStart.current = true;
      void invoke<RemotePwaAffordances>('remote:pwa-affordances')
        .then(result => setAffordance({ availableModes: result.voiceTranscription.availableModes, defaultMode: result.voiceTranscription.defaultMode }))
        .catch(() => setAffordance({ availableModes: [], defaultMode: 'streaming' }));
      return;
    }
    begin();
  };

  const stop = () => {
    wantStart.current = false;
    if (starting.current) releasedWhileStarting.current = true;
    else if (voiceRef.current.isRecording) void voiceRef.current.stop();
  };

  return {
    start,
    stop,
    toggle: () => (voiceRef.current.isRecording || starting.current ? stop() : start()),
    listening: voice.isRecording,
    finishing: voice.isTranscribing,
    preview: [voice.streamingTranscript, voice.interimTranscript].filter(Boolean).join(' ').trim(),
    problem,
    dismiss: () => { setProblem(null); voice.clearError(); },
  };
}

/** The bar at the bottom of the window while R2 is held, and a short note when dictation can't run. */
export function ListeningBar({ dictation }: { dictation: ControllerDictation }) {
  const { listening, finishing, preview, problem } = dictation;
  if (!listening && !finishing && !problem) return null;
  return (
    <div role="status" data-testid="controller-listening-bar"
      className="fixed bottom-4 left-1/2 z-modal flex max-w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-border-primary bg-surface-primary px-4 py-2 text-sm text-text-primary shadow-lg">
      {problem ? (
        <>
          <span className="text-text-secondary">{problem.text}</span>
          {problem.settings && (
            <button type="button" className="shrink-0 underline" onClick={() => { dictation.dismiss(); requestOpenSettings({ category: 'integrations' }); }}>Open Settings</button>
          )}
          <button type="button" className="shrink-0 text-text-tertiary" onClick={dictation.dismiss}>Dismiss</button>
        </>
      ) : (
        <>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-selected">
            <Mic className={`h-4 w-4 ${listening ? 'animate-pulse text-status-error' : 'text-text-secondary'}`} aria-hidden />
          </span>
          <span className="min-w-0 truncate">{preview || (listening ? 'Listening… let go to put the words in the box' : 'Finishing…')}</span>
        </>
      )}
    </div>
  );
}
