import type { EditorProps } from '@monaco-editor/react';

/** Only replace Monaco's UI adapter; FileEditorView owns the real load/save state. */
export default function EditorInput({ value, onChange, options }: EditorProps) {
  return <textarea aria-label="Editor content" value={value} readOnly={options?.readOnly} onChange={event => {
    // SAFETY: FileEditorView only consumes the first argument of Monaco's change callback.
    onChange?.(event.target.value, {} as Parameters<NonNullable<EditorProps['onChange']>>[1]);
  }} />;
}
