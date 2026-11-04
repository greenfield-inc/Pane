import { useEffect, useState } from 'react';
import { Check, Copy, Eye, EyeOff, KeyRound, Trash2 } from 'lucide-react';
import { IconButton } from '../ui/Button';
import { Input } from '../ui/Input';

interface SecretFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  helperText?: string;
  error?: string;
  onChange?: (value: string) => void;
  onRemove?: () => void;
  readOnly?: boolean;
}

export function SecretField({ label, value, placeholder, helperText, error, onChange, onRemove, readOnly = false }: SecretFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const configured = value.trim().length > 0;

  useEffect(() => {
    if (!configured) setRevealed(false);
  }, [configured]);

  const copy = async () => {
    if (!configured) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="ph-no-capture space-y-2 rounded-md border border-border-secondary p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound className="h-4 w-4 flex-none text-text-tertiary" />
          <span className="truncate text-sm font-medium text-text-primary">{label}</span>
          <span className="text-xs text-text-tertiary">{configured ? 'Configured' : 'Empty'}</span>
        </div>
        {configured && (
          <div className="flex items-center gap-1">
            <IconButton
              type="button"
              size="sm"
              aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
              title={revealed ? 'Hide' : 'Reveal'}
              icon={revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              onClick={() => setRevealed((current) => !current)}
            />
            <IconButton
              type="button"
              size="sm"
              aria-label={`Copy ${label}`}
              title="Copy"
              icon={copied ? <Check className="h-4 w-4 text-status-success" /> : <Copy className="h-4 w-4" />}
              onClick={copy}
            />
            {!readOnly && onRemove && (
              <IconButton
                type="button"
                size="sm"
                variant="danger"
                aria-label={`Remove ${label}`}
                title="Remove"
                icon={<Trash2 className="h-4 w-4" />}
                onClick={onRemove}
              />
            )}
          </div>
        )}
      </div>
      <div className="flex items-end gap-2">
        <Input
          aria-label={label}
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          readOnly={readOnly}
          placeholder={configured ? `Replace ${label}` : placeholder}
          helperText={helperText}
          error={error}
          autoComplete="off"
          fullWidth
        />
      </div>
    </div>
  );
}
