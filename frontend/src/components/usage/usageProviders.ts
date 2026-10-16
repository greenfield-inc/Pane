import { USAGE_PROVIDER_CATALOG } from '../../../../shared/types/usage';

/** Catalog entries in display order, so copy never names providers by hand. */
export const USAGE_PROVIDERS = Object.values(USAGE_PROVIDER_CATALOG);

const conjunction = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** "A", "A and B", "A, B, and C". */
export function joinLabels(labels: readonly string[]): string {
  return conjunction.format(labels);
}
