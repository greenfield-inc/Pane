import { create } from 'zustand';

import type { BoardTile } from './statusBoard';

interface BoardTileState {
  tile: BoardTile;
  select(tile: BoardTile): void;
}

/** Home's selected tile. It survives switching machines (which remounts home); a launch starts on Needs you. */
export const useBoardTile = create<BoardTileState>(set => ({
  tile: 'needs',
  select: tile => set({ tile }),
}));
