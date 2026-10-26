import { boundary, type BoundarySchema } from '../validation/boundaryDecoder';

export interface TerminalPathContext {
  workingDirectory: string;
  homeDirectory: string | null;
}

export const terminalPathContextSchema: BoundarySchema<TerminalPathContext> = boundary.object({
  workingDirectory: boundary.string,
  homeDirectory: boundary.nullable(boundary.string),
});
