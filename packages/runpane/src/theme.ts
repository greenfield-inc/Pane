import { boundary, decodeBoundary, type BoundarySchema, type JsonObject } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon } from './daemonClient';
import { RunpaneError } from './errors';

// `runpane theme`: Pane's own Custom theme. Pane checks every value; this file only shapes the request.

interface CustomTheme {
  base: string;
  name?: string;
  colors: JsonObject;
  css?: string;
}

const customThemeSchema: BoundarySchema<CustomTheme> = boundary.object({
  base: boundary.string,
  name: boundary.optional(boundary.string),
  colors: boundary.jsonObject,
  css: boundary.optional(boundary.string),
});
const readResultSchema = boundary.object({
  ok: boundary.literal(true),
  selected: boundary.object({
    appearanceMode: boundary.enumeration('system', 'fixed'),
    theme: boundary.string,
    systemLightTheme: boundary.string,
    systemDarkTheme: boundary.string,
  }),
  showing: boundary.string,
  showingPalette: boundary.string,
  custom: boundary.nullable(customThemeSchema),
  ignoredBecause: boundary.nullable(boundary.string),
  file: boundary.string,
  bases: boundary.array(boundary.string),
  tokens: boundary.array(boundary.object({ name: boundary.string, value: boundary.optional(boundary.string) })),
  parts: boundary.array(boundary.string),
  cssLimit: boundary.number,
  guide: boundary.string,
});
const setResultSchema = boundary.object({
  ok: boundary.literal(true),
  selected: boundary.string,
  custom: boundary.nullable(customThemeSchema),
  file: boundary.optional(boundary.string),
});
const resetResultSchema = boundary.object({
  ok: boundary.literal(true),
  removed: boundary.boolean,
  selected: boundary.nullable(boundary.string),
  file: boundary.string,
});

function parseColors(text: string): JsonObject {
  try {
    return decodeBoundary(JSON.parse(text), boundary.jsonObject);
  } catch {
    throw new RunpaneError('THEME_INVALID', '--colors must be a JSON object of token to colour. Nothing was changed.', 'Pass something like --colors \'{"--color-border-primary": "#30363d"}\'.');
  }
}

export async function runThemeRead(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon('runpane:theme:read', [{}], readResultSchema, { paneDir: parsed.paneDir });
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`Showing: ${result.showing === 'custom' ? `Custom (based on ${result.showingPalette})` : result.showing}`);
  if (result.custom) {
    console.log(`Custom theme (${result.file}): base ${result.custom.base}, ${Object.keys(result.custom.colors).length} colour overrides, ${result.custom.css?.length ?? 0} characters of CSS`);
  }
  if (result.ignoredBecause) console.log(result.ignoredBecause);
  console.log('');
  console.log(result.guide);
  console.log('');
  console.log('Colour tokens:');
  for (const token of result.tokens) console.log(`  ${token.name}${token.value ? `: ${token.value}` : ''}`);
  return 0;
}

export async function runThemeSet(parsed: ParsedArgs): Promise<number> {
  const request = {
    ...(parsed.themeId !== undefined && { theme: parsed.themeId }),
    ...(parsed.baseBranch !== undefined && { base: parsed.baseBranch }),
    ...(parsed.name !== undefined && { name: parsed.name }),
    ...(parsed.themeColors !== undefined && { colors: parseColors(parsed.themeColors) }),
    ...(parsed.themeCss !== undefined && { css: parsed.themeCss }),
  };
  if (Object.keys(request).length === 0) {
    throw new RunpaneError('THEME_INVALID', 'runpane theme set needs --theme, or at least one of --base, --colors, --css and --name. Nothing was changed.', 'Run `runpane theme read` for the tokens and selectors, then pass the change.');
  }
  const result = await invokeDaemon('runpane:theme:set', [request], setResultSchema, { paneDir: parsed.paneDir });
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else if (result.selected === 'custom' && result.custom) console.log(`Pane now shows the Custom theme, based on ${result.custom.base}.`);
  else console.log(`Pane now shows ${result.selected}.`);
  return 0;
}

export async function runThemeReset(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon('runpane:theme:reset', [{}], resetResultSchema, { paneDir: parsed.paneDir });
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else if (result.removed) console.log(`Deleted the Custom theme${result.selected ? `; Pane now shows ${result.selected}` : ''}.`);
  else console.log('There was no Custom theme; nothing changed.');
  return 0;
}
