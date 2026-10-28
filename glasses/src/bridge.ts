import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';

/** The part of the Even bridge the app uses; tests pass a fake. */
export type GlassesBridge = Pick<
  EvenAppBridge,
  | 'createStartUpPageContainer'
  | 'rebuildPageContainer'
  | 'textContainerUpgrade'
  | 'shutDownPageContainer'
  | 'audioControl'
  | 'setLocalStorage'
  | 'getLocalStorage'
>;
