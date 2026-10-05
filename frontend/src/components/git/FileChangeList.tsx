import type { GitCommitFileChange, GitFileChangeStatus } from '../../../../shared/types/git';

/**
 * Rows of changed files with their change kind and +/- counts.
 *
 * Presentational only — it never fetches. A commit expands into one of these
 * ({@link CommitFileList}), and so does a pull request, which compares against
 * a base branch instead of a parent commit; both want the identical row.
 */

const STATUS_LABEL = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  unmerged: 'U',
  unknown: '?',
} satisfies Record<GitFileChangeStatus, string>;

const STATUS_CLASS = {
  added: 'text-status-success',
  modified: 'text-interactive',
  deleted: 'text-status-error',
  renamed: 'text-interactive',
  copied: 'text-interactive',
  typechange: 'text-status-warning',
  unmerged: 'text-status-warning',
  unknown: 'text-text-muted',
} satisfies Record<GitFileChangeStatus, string>;

const STATUS_TITLE = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  typechange: 'Type changed',
  unmerged: 'Unmerged',
  unknown: 'Unknown change',
} satisfies Record<GitFileChangeStatus, string>;

function splitPath(path: string) {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return { dir: '', name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

function FileChangeRow({
  file,
  onClick,
  indentClass = 'pl-6',
}: {
  file: GitCommitFileChange;
  onClick?: () => void;
  indentClass?: string;
}) {
  const { dir, name } = splitPath(file.path);
  const statusTitle = STATUS_TITLE[file.status];
  const title = file.status === 'renamed' || file.status === 'copied'
    ? `${statusTitle} from ${file.oldPath} to ${file.path}`
    : `${statusTitle}: ${file.path}`;

  const body = (
    <>
      <span
        className={`w-3 flex-shrink-0 font-mono text-[10px] leading-none ${STATUS_CLASS[file.status]}`}
        aria-hidden="true"
      >
        {STATUS_LABEL[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-[11px] leading-snug">
        {dir && <span className="text-text-muted">{dir}</span>}
        <span className="text-text-secondary">{name}</span>
      </span>
      <span className="flex flex-shrink-0 items-center gap-1 font-mono text-[10px] leading-none">
        {file.isBinary ? (
          <span className="text-text-muted">bin</span>
        ) : (
          <>
            {(file.additions ?? 0) > 0 && <span className="text-status-success">+{file.additions}</span>}
            {(file.deletions ?? 0) > 0 && <span className="text-status-error">-{file.deletions}</span>}
            {file.additions === null && file.deletions === null && (
              <span className="text-text-muted">new</span>
            )}
          </>
        )}
      </span>
    </>
  );

  if (!onClick) {
    return (
      <div className={`flex items-center gap-1.5 py-0.5 pr-2 ${indentClass}`} title={title}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={`${statusTitle}: ${file.path}. Show diff.`}
      className={`flex w-full items-center gap-1.5 rounded-sm py-0.5 pr-2 transition-colors hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-inset focus:ring-interactive ${indentClass}`}
    >
      {body}
    </button>
  );
}

export interface FileChangeListProps {
  files: GitCommitFileChange[];
  /** Called when a row is activated; wire this to reveal the file's diff. */
  onFileClick?: (path: string) => void;
  /** Row indentation — nested under a commit, or flush in a dialog. */
  indentClass?: string;
  className?: string;
}

export function FileChangeList({ files, onFileClick, indentClass, className = '' }: FileChangeListProps) {
  return (
    <div className={className}>
      {files.map(file => (
        <FileChangeRow
          key={`${file.status}-${file.oldPath}-${file.path}`}
          file={file}
          indentClass={indentClass}
          onClick={onFileClick ? () => onFileClick(file.path) : undefined}
        />
      ))}
    </div>
  );
}
