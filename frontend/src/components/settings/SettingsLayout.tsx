import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useScrollSurface } from '../../hooks/useScrollSurface';
import type { SettingsCategoryDefinition } from './catalog';
import type { SettingsCategoryId } from '../../types/settings';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/Select';
import { cn } from '../../utils/cn';

interface SettingsLayoutProps {
  category: SettingsCategoryId;
  categories: readonly SettingsCategoryDefinition[];
  onCategoryChange: (category: SettingsCategoryId) => void;
  onBack: () => void;
  fullBleed?: boolean;
  children: ReactNode;
}
export function SettingsLayout({ category, categories, onCategoryChange, onBack, fullBleed = false, children }: SettingsLayoutProps) {
  const handleCategoryChange = (value: string) => {
    // SAFETY: The Select items are generated exclusively from SettingsCategoryId values.
    onCategoryChange(value as SettingsCategoryId);
  };
  const scrollSurfaceRef = useScrollSurface<HTMLElement>({
    id: 'settings-content',
    priority: 80,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="hidden min-h-0 flex-col border-r border-border-primary bg-surface-secondary p-3 md:flex">
        <button type="button" onClick={onBack} className="mb-3 inline-flex h-7 items-center gap-1.5 rounded px-2 text-left text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </button>
        <h1 className="mb-4 px-2 text-[14px] font-semibold text-text-primary">Settings</h1>
        <nav aria-label="Settings categories" className="min-h-0 space-y-0.5 overflow-y-auto">
          {categories.map((item) => {
            const Icon = item.icon;
            const selected = item.id === category;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={selected ? 'page' : undefined}
                disabled={item.availability?.disabled}
                title={item.availability?.reason}
                onClick={() => onCategoryChange(item.id)}
                className={cn(
                  'flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle',
                  selected
                    ? 'bg-surface-selected font-medium text-text-primary'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                  item.availability?.disabled && 'cursor-not-allowed opacity-45',
                )}
              >
                <Icon className="h-3.5 w-3.5 flex-none text-text-tertiary" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="border-b border-border-primary p-3 md:hidden">
        <button type="button" onClick={onBack} className="mb-2 inline-flex items-center gap-1 text-xs text-text-secondary"><ArrowLeft className="h-3.5 w-3.5" /> Back</button>
        <label className="mb-1.5 block text-xs font-medium text-text-secondary" htmlFor="settings-category-select">
          Category
        </label>
        <Select value={category} onValueChange={handleCategoryChange}>
          <SelectTrigger id="settings-category-select" aria-label="Settings category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {categories.map((item) => (
              <SelectItem key={item.id} value={item.id} disabled={item.availability?.disabled}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <main ref={scrollSurfaceRef} tabIndex={-1} className={cn('min-h-0', fullBleed ? 'overflow-hidden' : 'overflow-y-auto px-5 py-6 sm:px-7 md:px-9')} data-testid="settings-content">
        {children}
      </main>
    </div>
  );
}
