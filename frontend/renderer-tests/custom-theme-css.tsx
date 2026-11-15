import { applyCustomThemeStyles } from '../src/utils/customTheme';

// Applies a Custom theme's CSS the way the app does and returns the rules the page keeps.
window.customThemeCssTest = {
  apply: (css: string) => {
    applyCustomThemeStyles({ base: 'dusk', colors: {}, css });
    return document.adoptedStyleSheets.flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText)).join('\n');
  },
};
