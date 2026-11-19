import React from 'react';
import { AppWindow, Download, ExternalLink, X } from 'lucide-react';
import type { BrowserTabNotice } from '../../../../../shared/types/browser';

export interface ShownTabNotice {
  key: string;
  notice: BrowserTabNotice;
}

interface TabNoticesProps {
  notices: ShownTabNotice[];
  onOpenApp: (key: string, id: string) => void;
  onShowInFolder: (file: string) => void;
  onDismiss: (key: string) => void;
}

const ACTION = 'flex-shrink-0 rounded px-1.5 py-0.5 font-medium text-interactive hover:bg-surface-hover hover:text-interactive-hover';

/** Lines under a browser tab's address bar: an app link to confirm, a sign-in sent out, a finished download. */
export const TabNotices: React.FC<TabNoticesProps> = ({ notices, onOpenApp, onShowInFolder, onDismiss }) => (
  <>
    {notices.map(({ key, notice }) => (
      <div key={key} role="status" className="flex items-center gap-1.5 border-b border-border-primary bg-bg-primary px-2 py-1 text-xs text-text-secondary">
        {notice.kind === 'app' && <>
          <AppWindow className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
          <span className="min-w-0 flex-1 truncate" title={`${notice.scheme}: link`}>This page wants to open {notice.app ?? 'an app outside Pane'}.</span>
          <button type="button" className={ACTION} onClick={() => onOpenApp(key, notice.id)}>Open</button>
          <button type="button" className={ACTION} onClick={() => onDismiss(key)}>Cancel</button>
        </>}
        {notice.kind === 'sent-out' && <>
          <ExternalLink className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
          <span className="min-w-0 flex-1 truncate">{notice.site} doesn&apos;t work in Pane&apos;s browser, so it opened in your system browser.</span>
        </>}
        {notice.kind === 'downloaded' && <>
          <Download className="h-3.5 w-3.5 flex-shrink-0 text-status-success" />
          <span className="min-w-0 truncate" title={notice.file}>Downloaded {notice.name}</span>
          <span aria-hidden className="text-text-tertiary">·</span>
          <button type="button" className={ACTION} onClick={() => onShowInFolder(notice.file)}>Show in folder</button>
          <span className="flex-1" />
        </>}
        {notice.kind !== 'app' && (
          <button type="button" onClick={() => onDismiss(key)} className="flex-shrink-0 rounded p-0.5 hover:bg-surface-hover hover:text-text-primary" title="Dismiss" aria-label="Dismiss">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    ))}
  </>
);
