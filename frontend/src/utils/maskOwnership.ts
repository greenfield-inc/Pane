/**
 * Shared ownership of one loading mask. Every task that covers the terminal
 * (activation refresh, manual refresh, maximize/restore refit) takes its own
 * claim and releases only that claim, so an older task finishing late can
 * never uncover a newer one. The mask shows while any claim is held.
 */
export interface MaskOwnership {
  /** Takes a claim; the returned release is idempotent. */
  acquire: () => () => void;
  readonly held: boolean;
}

export function createMaskOwnership(onChange: (masked: boolean) => void): MaskOwnership {
  const claims = new Set<symbol>();
  return {
    acquire() {
      const claim = Symbol('mask');
      claims.add(claim);
      if (claims.size === 1) onChange(true);
      return () => {
        if (!claims.delete(claim)) return;
        if (claims.size === 0) onChange(false);
      };
    },
    get held() {
      return claims.size > 0;
    },
  };
}
