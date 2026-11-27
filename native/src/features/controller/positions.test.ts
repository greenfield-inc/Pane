import { describe, expect, it } from 'vitest';

import { namesByLabel, toPosition } from './positions';

describe('toPosition', () => {
  it('reads Xbox-style raw names as positions', () => {
    expect(['a', 'b', 'x', 'y'].map(b => toPosition(b as 'a', false))).toEqual(['south', 'east', 'west', 'north']);
  });

  it('puts a labelled pad\'s A on the right and B at the bottom (Switch layout)', () => {
    expect(['a', 'b', 'x', 'y'].map(b => toPosition(b as 'a', true))).toEqual(['east', 'south', 'north', 'west']);
  });

  it('leaves shoulders, sticks and the D-pad alone', () => {
    expect(toPosition('r2', true)).toBe('r2');
    expect(toPosition('up', true)).toBe('up');
  });
});

describe('namesByLabel', () => {
  it('is false for a Switch Pro Controller on Android (057e:2009), whose key layout is positional', () => {
    expect(namesByLabel('android', { id: '1', vendorId: 0x057e, productId: 0x2009 })).toBe(false);
  });

  it('is false for an Xbox pad on Android (045e:0b13)', () => {
    expect(namesByLabel('android', { id: '1', vendorId: 0x045e, productId: 0x0b13 })).toBe(false);
  });

  it('follows the product category on iPhone', () => {
    expect(namesByLabel('ios', { id: '1', appleCategory: 'Switch Pro Controller' })).toBe(true);
    expect(namesByLabel('ios', { id: '1', appleCategory: 'Xbox One' })).toBe(false);
  });
});
