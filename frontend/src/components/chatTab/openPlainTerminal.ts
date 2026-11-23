import { createContext } from 'react';

export const OpenPlainTerminalContext = createContext<(() => void) | undefined>(undefined);
