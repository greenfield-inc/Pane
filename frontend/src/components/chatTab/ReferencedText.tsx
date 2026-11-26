import { useContext, useMemo } from 'react';
import { referenceSegments } from '../../../../shared/composerMentions';
import { ChatReferencesContext } from './chatReferences';

/** A span, not a button: a button is a box of its own and would not wrap with the text around it. */
function FileMark({ text, path, open }: { text: string; path: string; open: (path: string) => void }) {
  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- See above.
  return <span role="button" tabIndex={0} className="chat-mark chat-mark-file" title={`Open ${path}`} onClick={() => open(path)}
    onKeyDown={event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open(path);
    }}>{text}</span>;
}

/** A sent message's text with its file and skill references marked, as in the message box. */
export function ReferencedText({ text }: { text: string }) {
  const { skills, openFile } = useContext(ChatReferencesContext);
  const segments = useMemo(() => referenceSegments(text, skills), [text, skills]);
  return <span className="whitespace-pre-wrap">{segments.map(({ text: part, start, reference }) => {
    if (!reference) return part;
    if (reference.kind === 'file' && openFile) return <FileMark key={start} text={part} path={reference.path} open={openFile} />;
    return <mark key={start} className="chat-mark">{part}</mark>;
  })}</span>;
}
