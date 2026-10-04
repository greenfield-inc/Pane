import { useState } from 'react';
import { Button } from './ui/Button';
import { EnhancedInput } from './ui/EnhancedInput';
import { HostFolderBrowser } from './HostFolderBrowser';
import { API } from '../utils/api';
import { folderBrowseTarget, type ActiveHost } from '../utils/hostRepoActions';

interface HostFolderFieldProps {
  host: ActiveHost;
  /** Accessible name of the path input, e.g. "Repository Path". */
  label: string;
  value: string;
  onChange: (path: string) => void;
  placeholder: string;
  /** Lets the in-app browser create a folder (new projects and clone destinations). */
  allowCreate: boolean;
  required?: boolean;
  showRequiredIndicator?: boolean;
}

/**
 * A typed path plus Browse, both on the active host: this computer gets the
 * native dialog; a remote host gets the in-app browser over its own folders.
 */
export function HostFolderField({
  host,
  label,
  value,
  onChange,
  placeholder,
  allowCreate,
  required,
  showRequiredIndicator,
}: HostFolderFieldProps) {
  const [browsing, setBrowsing] = useState(false);

  const browse = async () => {
    if (folderBrowseTarget(host) === 'host') {
      setBrowsing(true);
      return;
    }
    const result = await API.dialog.openDirectory();
    if (result.success && result.data) onChange(result.data);
  };

  return (
    <div className="space-y-2">
      <EnhancedInput
        type="text"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        size="lg"
        fullWidth
        required={required}
        showRequiredIndicator={showRequiredIndicator}
      />
      <div className="flex justify-end">
        <Button onClick={() => void browse()} variant="secondary" size="sm">
          Browse
        </Button>
      </div>
      <HostFolderBrowser
        isOpen={browsing}
        host={host}
        allowCreate={allowCreate}
        onSelect={(path) => {
          setBrowsing(false);
          onChange(path);
        }}
        onClose={() => setBrowsing(false)}
      />
    </div>
  );
}
