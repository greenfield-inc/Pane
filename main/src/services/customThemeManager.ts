import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { PaneError } from '../../../shared/paneError';
import { DEFAULT_APPEARANCE, isLightTheme, normalizeAppearance, THEME_CLASSES, type Theme } from '../../../shared/types/appearance';
import {
  checkCustomTheme,
  CUSTOM_THEME_FILE,
  CUSTOM_THEME_FILE_LIMIT,
  CUSTOM_THEME_ID,
  isThemeChoice,
  selectsCustomTheme,
  type CustomTheme,
  type CustomThemeState,
  type ThemeChoice,
} from '../../../shared/types/customTheme';
import type { AppConfig } from '../types/config';

/** The slice of ConfigManager the Custom theme needs: the selection lives in config.json. */
export interface AppearanceStore {
  getConfig(): AppConfig;
  updateConfigWith(update: (current: AppConfig) => Partial<AppConfig>): Promise<AppConfig>;
}

export interface CustomThemeSetRequest {
  base?: Theme;
  name?: string;
  /** Merged into the current colours; null removes an override. */
  colors?: Record<string, string | null>;
  /** Replaces the current CSS; empty text removes it. */
  css?: string;
}

const RELOAD_DEBOUNCE_MS = 100;

/** Every slot that selects Custom, pointed at `base` instead; a slot's default only when the base is unknown. */
function replaceCustom(config: AppConfig, base: Theme | null): Partial<AppConfig> {
  const updates: Partial<AppConfig> = {};
  if (config.theme === CUSTOM_THEME_ID) updates.theme = base ?? DEFAULT_APPEARANCE.theme;
  if (config.systemLightTheme === CUSTOM_THEME_ID) updates.systemLightTheme = base ?? DEFAULT_APPEARANCE.systemLightTheme;
  if (config.systemDarkTheme === CUSTOM_THEME_ID) updates.systemDarkTheme = base ?? DEFAULT_APPEARANCE.systemDarkTheme;
  return updates;
}

/**
 * custom-theme.json in Pane's data folder. ConfigManager's folder watch calls
 * `scheduleReload` when the file changes, so nothing new runs while it is idle.
 * Emits 'changed' with the new state whenever what the windows should show changes.
 */
export class CustomThemeManager extends EventEmitter {
  readonly filePath: string;
  private state: CustomThemeState = { theme: null, base: null, error: null };
  private lastText: string | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(directory: string, private readonly config: AppearanceStore) {
    super();
    this.filePath = path.join(directory, CUSTOM_THEME_FILE);
  }

  getState(): CustomThemeState {
    return this.state;
  }

  /** Reads the file once at startup, before any window needs the theme. */
  loadSync(): void {
    let text: string | null;
    try {
      text = readFileSync(this.filePath, 'utf8');
    } catch {
      text = null;
    }
    this.apply(text);
  }

  scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.reload().catch((error) => console.error('[CustomTheme] Reload failed:', error));
    }, RELOAD_DEBOUNCE_MS);
    this.reloadTimer.unref?.();
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
  }

  /** Re-reads the file; when it is gone while Custom is selected, selects its base. */
  async reload(): Promise<void> {
    let text: string | null;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch {
      text = null;
    }
    const changed = this.apply(text);
    if (text === null) await this.deselectIfSelected();
    if (changed) this.emit('changed', this.state);
  }

  /** Startup clean-up: a selection of Custom with no file shows its base palette instead. An invalid file keeps the selection, so fixing it brings Custom back. */
  async deselectIfSelected(): Promise<void> {
    if (this.lastText !== null || !selectsCustomTheme(normalizeAppearance(this.config.getConfig()).appearance)) return;
    await this.config.updateConfigWith((current) => replaceCustom(current, this.state.base));
  }

  /** Checks, merges and writes the Custom theme, then selects it. Nothing is written when it is refused. */
  async set(request: CustomThemeSetRequest, onScreen: Theme): Promise<CustomTheme> {
    const current = this.state.theme;
    const colors = { ...current?.colors };
    for (const [token, value] of Object.entries(request.colors ?? {})) {
      if (value === null) delete colors[token];
      else colors[token] = value;
    }
    const candidate = {
      base: request.base ?? current?.base ?? onScreen,
      ...(request.name !== undefined ? { name: request.name } : current?.name ? { name: current.name } : {}),
      colors,
      ...(request.css !== undefined ? { css: request.css } : current?.css ? { css: current.css } : {}),
    };
    const check = checkCustomTheme(candidate);
    if (!check.ok) {
      throw new PaneError('THEME_INVALID', `${check.reason} Nothing was changed.`, 'Fix that value and run `runpane theme set` again. `runpane theme read` lists the tokens, bases and selectors.');
    }
    const text = `${JSON.stringify(check.theme, null, 2)}\n`;
    if (Buffer.byteLength(text) > CUSTOM_THEME_FILE_LIMIT) {
      throw new PaneError('THEME_INVALID', `The theme would be ${Buffer.byteLength(text)} bytes; the file limit is ${CUSTOM_THEME_FILE_LIMIT}. Nothing was changed.`, 'Remove some CSS or colours and try again.');
    }
    const previousBase = current?.base ?? null;
    await this.writeAtomically(text);
    // The windows get the theme before the selection, so they never show Custom without its contents.
    if (this.apply(text)) this.emit('changed', this.state);
    await this.select(CUSTOM_THEME_ID, check.theme.base, previousBase);
    return check.theme;
  }

  /**
   * Selects `choice` where the person sees it now: as the fixed theme, or in the System slot of its
   * light or dark family. Custom takes its base's family, and a stale Custom in the other slot goes back to `previousBase`.
   */
  async select(choice: ThemeChoice, customBase: Theme | null = this.state.base, previousBase: Theme | null = null): Promise<void> {
    if (!isThemeChoice(choice)) throw new PaneError('THEME_INVALID', `${String(choice)} is not a Pane theme. Nothing was changed.`, `Use custom or one of: ${Object.keys(THEME_CLASSES).join(', ')}.`);
    if (choice === CUSTOM_THEME_ID && !this.state.theme) {
      throw new PaneError('THEME_NO_CUSTOM', 'There is no Custom theme to select. Nothing was changed.', 'Create one with `runpane theme set --base <theme> --colors <json>`.');
    }
    const palette = choice === CUSTOM_THEME_ID ? customBase : choice;
    await this.config.updateConfigWith((config) => {
      if ((config.appearanceMode ?? 'system') === 'fixed') return { theme: choice };
      const light = palette ? isLightTheme(palette) : true;
      const updates: Partial<AppConfig> = light ? { systemLightTheme: choice } : { systemDarkTheme: choice };
      const other = light ? 'systemDarkTheme' : 'systemLightTheme';
      if (choice === CUSTOM_THEME_ID && config[other] === CUSTOM_THEME_ID) {
        updates[other] = previousBase && isLightTheme(previousBase) === !light ? previousBase : light ? 'dusk-oled' : 'folio';
      }
      return updates;
    });
  }

  /** Deletes the Custom theme and selects its base. */
  async reset(): Promise<{ removed: boolean; base: Theme | null }> {
    const base = this.state.base;
    let removed = true;
    try {
      await fs.unlink(this.filePath);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      removed = false;
    }
    const changed = this.apply(null);
    await this.config.updateConfigWith((current) => replaceCustom(current, base));
    if (changed) this.emit('changed', this.state);
    return { removed, base };
  }

  private async writeAtomically(text: string): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, text, 'utf8');
    try {
      await fs.rename(temp, this.filePath);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  /** Loads `text` (null: no file) into the state; returns whether it changed. */
  private apply(text: string | null): boolean {
    if (text === this.lastText && this.lastText !== null) return false;
    const previous = JSON.stringify(this.state);
    this.lastText = text;
    if (text === null) {
      this.state = { theme: null, base: this.state.base, error: null };
    } else if (Buffer.byteLength(text) > CUSTOM_THEME_FILE_LIMIT) {
      this.state = { theme: null, base: this.state.base, error: `${CUSTOM_THEME_FILE} is larger than ${CUSTOM_THEME_FILE_LIMIT} bytes, so Pane ignored it.` };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.replace(/^﻿/, ''));
      } catch (error) {
        this.state = { theme: null, base: this.state.base, error: `${CUSTOM_THEME_FILE} is not valid JSON (${error instanceof Error ? error.message : String(error)}), so Pane ignored it.` };
        return JSON.stringify(this.state) !== previous;
      }
      const check = checkCustomTheme(parsed);
      this.state = check.ok
        ? { theme: check.theme, base: check.theme.base, error: null }
        : { theme: null, base: check.base ?? this.state.base, error: `Pane ignored ${CUSTOM_THEME_FILE}: ${check.reason}` };
    }
    if (this.state.error) console.warn(`[CustomTheme] ${this.state.error}`);
    return JSON.stringify(this.state) !== previous;
  }
}
