import { describe, expect, it } from 'vitest';
import { placesForMacWork } from './macWork';

const studio = { id: 'studio', name: 'mac-studio', os: 'macOS' as const };
const linuxBox = { id: 'linux', name: 'build-box', os: 'Linux' as const };
const pc = { id: 'local', name: 'gaming-pc', os: 'Windows' as const };
const laptop = { id: 'local', name: 'maya-macbook', os: 'macOS' as const };

describe('places for a repo with an Xcode project', () => {
  it('keeps This Mac first and selected when the window is on a Mac', () => {
    expect(placesForMacWork({ current: laptop, others: [linuxBox, studio], xcode: true })).toEqual({ others: [studio, linuxBox], preferred: 'here', macAvailable: true });
  });

  it('lists another Mac first and selects it when the window is not on a Mac', () => {
    expect(placesForMacWork({ current: pc, others: [linuxBox, studio], xcode: true })).toEqual({ others: [studio, linuxBox], preferred: 'studio', macAvailable: true });
  });

  it('has no Mac to offer when none is paired', () => {
    expect(placesForMacWork({ current: pc, others: [linuxBox], xcode: true })).toEqual({ others: [linuxBox], preferred: null, macAvailable: false });
  });

  it('leaves the usual order and default for a repo without one', () => {
    expect(placesForMacWork({ current: pc, others: [linuxBox, studio], xcode: false })).toEqual({ others: [linuxBox, studio], preferred: null, macAvailable: true });
  });
});
