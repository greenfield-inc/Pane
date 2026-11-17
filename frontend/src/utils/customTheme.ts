import { useSyncExternalStore } from 'react';
import { isTheme } from '../../../shared/types/appearance';
import { checkCustomTheme, customThemeColorRule, type CustomTheme, type CustomThemeState } from '../../../shared/types/customTheme';

/**
 * The Custom theme in this window: main's state (custom-theme.json), kept live
 * by `custom-theme:updated`, and cached so the next launch paints it at once.
 */

const CACHE_KEY = 'pane.custom-theme.v1';
const EMPTY: CustomThemeState = { theme: null, base: null, error: null };

function readCache(): CustomThemeState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Establishes the cached JSON object before its fields are checked.
    if (typeof raw !== 'object' || raw === null || !('base' in raw)) return EMPTY;
    const check = 'theme' in raw && raw.theme ? checkCustomTheme(raw.theme) : null;
    const theme = check?.ok ? check.theme : null;
    return { theme, base: isTheme(raw.base) ? raw.base : theme?.base ?? null, error: null };
  } catch {
    return EMPTY;
  }
}

let state: CustomThemeState = readCache();
const listeners = new Set<() => void>();
let connected = false;

function setState(next: CustomThemeState): void {
  state = next;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ theme: next.theme, base: next.base }));
  } catch {
    // The cache only speeds up the next launch.
  }
  for (const listener of listeners) listener();
}

function connect(): void {
  if (connected || !window.electronAPI?.customTheme) return;
  connected = true;
  // A failure here leaves the cached theme in place; it must never stop the window from rendering.
  try {
    window.electronAPI.events.onCustomThemeUpdated?.(setState);
    void Promise.resolve(window.electronAPI.customTheme.get())
      .then((response) => { if (response?.success && response.data) setState(response.data); })
      .catch((error) => console.warn('[customTheme] Could not read the Custom theme:', error));
  } catch (error) {
    console.warn('[customTheme] Could not follow the Custom theme:', error);
  }
}

function subscribe(listener: () => void): () => void {
  connect();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useCustomThemeState = (): CustomThemeState => useSyncExternalStore(subscribe, () => state);
export const subscribeCustomTheme = subscribe;
export const getCustomThemeState = (): CustomThemeState => state;

// ---------------------------------------------------------------- applying it

const URL_FUNCTION = /url\(\s*(['"]?)([^'")]*)/gi;

/** Whether a parsed declaration value can't fetch anything: no backslash, and every url() a data: or #id address. */
function isLocalValue(value: string): boolean {
  if (value.includes('\\')) return false;
  if (/(^|[^\w-])(image-set|-webkit-image-set|src|image|element)\(/i.test(value)) return false;
  for (const match of value.matchAll(URL_FUNCTION)) {
    const address = match[2].trim().toLowerCase();
    if (!address.startsWith('data:') && !address.startsWith('#')) return false;
  }
  return true;
}

function cleanDeclarations(style: CSSStyleDeclaration): void {
  for (let index = style.length - 1; index >= 0; index--) {
    const property = style.item(index);
    if (!isLocalValue(style.getPropertyValue(property))) style.removeProperty(property);
  }
}

/**
 * The second layer behind main's text check (T3 Code's client guard): after the browser parses the
 * CSS, remove every declaration that could fetch, any value with a backslash, and at-rules it can't check.
 */
function filterRules(rules: CSSRuleList, owner: { deleteRule(index: number): void }): void {
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (rule instanceof CSSStyleRule) {
      cleanDeclarations(rule.style);
      if (rule.cssRules.length > 0) filterRules(rule.cssRules, rule);
    } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule || rule instanceof CSSLayerBlockRule || rule instanceof CSSContainerRule) {
      filterRules(rule.cssRules, rule);
    } else if (rule instanceof CSSKeyframesRule) {
      for (const keyframe of Array.from(rule.cssRules)) {
        if (keyframe instanceof CSSKeyframeRule) cleanDeclarations(keyframe.style);
      }
    } else if (!(rule instanceof CSSLayerStatementRule || rule instanceof CSSNamespaceRule)) {
      owner.deleteRule(index);
    }
  }
}

const sheets = new WeakMap<Document, CSSStyleSheet>();

/** Puts the Custom theme's colours and CSS into this document's one adopted sheet, after Pane's own styles; null empties it. */
export function applyCustomThemeStyles(theme: CustomTheme | null, doc: Document = document): void {
  // The colours index.html applied from the cache for the first frame give way to this sheet.
  doc.getElementById('pane-launch-custom-theme')?.remove();
  let sheet = sheets.get(doc);
  if (!sheet) {
    if (!theme) return;
    sheet = new CSSStyleSheet();
    sheets.set(doc, sheet);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  }
  if (!theme) {
    sheet.replaceSync('');
    return;
  }
  // A constructed sheet ignores @import. A theme the filter can't clean shows no custom styles rather than a blank window.
  try {
    sheet.replaceSync(`${customThemeColorRule(theme.colors)}\n${theme.css ?? ''}`);
    filterRules(sheet.cssRules, sheet);
  } catch (error) {
    sheet.replaceSync('');
    console.warn('[customTheme] Pane could not apply the Custom theme CSS, so it shows the base theme:', error);
  }
}
