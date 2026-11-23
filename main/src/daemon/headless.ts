import '../polyfills/readablestream';
import { warmShellPath } from '../utils/shellPath';

// The login-shell PATH probe runs while the daemon loads, so the first git command or
// terminal finds it done instead of blocking the main thread on a synchronous probe.
void warmShellPath();

// Imported after the probe starts, so the probe overlaps this load.
import { startHeadlessPaneProcess } from './startHeadless';

startHeadlessPaneProcess();
