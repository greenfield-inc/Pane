import { assertCard, type CardFields } from './cardCheck';
import { tidyCard, type TidiedCard } from './cardTidy';

/** A card as Pane posts it: tidied when it was an old paragraph card, with the checks' warnings. */
export interface AdmittedCard {
  card: CardFields;
  /** Set when Pane tidied it: the title and context exactly as sent (Show as sent). */
  asSent?: TidiedCard['asSent'];
  warnings: string[];
}

/**
 * The one step every way of asking reaches (runpane notify, runpane report, the MCP notify tool):
 * an old paragraph card is tidied by rule, then the card is checked. Throws the refusal as a
 * PaneError with a code and next step; otherwise returns the card and its warnings.
 */
export function admitCard(fields: CardFields, options: { tidy?: boolean } = {}): AdmittedCard {
  const tidied = options.tidy === false ? undefined : tidyCard(fields);
  const card = tidied?.card ?? fields;
  const warnings = assertCard(card);
  return tidied ? { card, asSent: tidied.asSent, warnings } : { card, warnings };
}
