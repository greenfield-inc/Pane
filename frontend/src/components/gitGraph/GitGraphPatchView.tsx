import { useEffect, useState } from 'react';
import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import type { DiffHighlighter } from '@git-diff-view/shiki';
import { isLightTheme, useTheme } from '../../contexts/ThemeContext';
import type { FileDiff } from '../../types/diff';
import { getShikiHighlighter } from '../panels/diff/diffSource';
import '@git-diff-view/react/styles/diff-view.css';

/** Full commit patches use the same renderer, highlighting and view preference as editor diff tabs. */
export function GitGraphPatchView({ files }: { files: FileDiff[] }) {
  const { theme } = useTheme();
  const [highlighter, setHighlighter] = useState<DiffHighlighter | null>(null);
  const [mode, setMode] = useState(() => localStorage.getItem('diffViewType') === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified);
  useEffect(() => {
    let cancelled = false;
    void getShikiHighlighter().then(value => { if (!cancelled) setHighlighter(value); });
    return () => { cancelled = true; };
  }, []);
  function chooseMode(value: DiffModeEnum) {
    setMode(value);
    localStorage.setItem('diffViewType', value === DiffModeEnum.Split ? 'split' : 'unified');
  }
  return <div className="min-w-0">
    <div className="flex gap-2 border-b border-border-primary p-2">
      <button type="button" onClick={() => chooseMode(DiffModeEnum.Unified)} aria-pressed={mode === DiffModeEnum.Unified}>Unified</button>
      <button type="button" onClick={() => chooseMode(DiffModeEnum.Split)} aria-pressed={mode === DiffModeEnum.Split}>Split</button>
    </div>
    {files.map(file => <details key={file.path} open className="border-b border-border-primary">
      <summary className="cursor-pointer px-3 py-2 text-sm text-text-primary">{file.path} <span className="text-status-success">+{file.additions}</span> <span className="text-status-error">-{file.deletions}</span></summary>
      {file.isBinary ? <p className="p-3 text-text-secondary">Binary file</p>
        : file.rawDiff.includes('@@') ? <DiffView data={{ oldFile: { fileName: file.oldPath }, newFile: { fileName: file.path }, hunks: [file.rawDiff] }} diffViewMode={mode} diffViewTheme={isLightTheme(theme) ? 'light' : 'dark'} diffViewHighlight={Boolean(highlighter)} registerHighlighter={highlighter ?? undefined} diffViewWrap={true} diffViewFontSize={13} />
          : <p className="p-3 text-text-secondary">{file.type === 'renamed' ? 'Renamed from ' + file.oldPath : 'No content changes'}</p>}
    </details>)}
  </div>;
}
