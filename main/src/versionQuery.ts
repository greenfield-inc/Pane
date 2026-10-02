// `pane --version` must answer before any service module loads: importing
// them opens and migrates the database in PANE_DIR. On Linux, runpane doctor
// runs the installed app with --version to read its version.
import { app } from 'electron';
import { hasVersionQueryArg } from './utils/runtimeMode';

if (hasVersionQueryArg()) {
  process.stdout.write(`${app.getVersion()}\n`);
  process.exit(0);
}
