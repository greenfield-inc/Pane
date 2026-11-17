import { create } from 'zustand';

import { secureStore } from '@/auth/secureStore';

import type { BoardTile } from './statusBoard';

const TILE_KEY = 'pane.native.boardTile';
const TILES: readonly BoardTile[] = ['all', 'needs', 'working', 'ready'];

interface BoardTileState {
  tile: BoardTile;
  select(tile: BoardTile): void;
}

/** Home's selected tile, per device. It survives switching machines and relaunches; the first launch starts on All panes. */
export const useBoardTile = create<BoardTileState>(set => ({
  tile: 'all',
  select: tile => {
    set({ tile });
    void secureStore.setItem(TILE_KEY, tile).catch(() => undefined);
  },
}));

void secureStore.getItem(TILE_KEY).then(saved => {
  const tile = TILES.find(id => id === saved);
  if (tile) useBoardTile.setState({ tile });
}).catch(() => undefined);
