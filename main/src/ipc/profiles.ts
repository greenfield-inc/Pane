import type { IpcMain } from 'electron';
import { PaneError, paneErrorText, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { profileFileChangesSchema } from '../../../shared/types/profileEditor';
import { ProfileEditor } from '../services/agentFarm/profileEditor';
import { getAppDirectory } from '../utils/appDirectory';
import type { AppServices } from './types';
import type { PaneCommandValue } from '../daemon/commandRegistry';

type ProfilesResponse<Data> = { success: true; data: Data } | { success: false; error: string };

async function respond<Data>(work: () => Promise<Data> | Data): Promise<ProfilesResponse<Data>> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    return { success: false, error: error instanceof PaneError ? paneErrorText(error) : `Pane couldn't change its profiles: ${reasonOf(error)}.` };
  }
}

const text = boundary.string;
const kindSchema = boundary.enumeration('subagent', 'skill', 'reference');

/**
 * The Profiles tab (T-63 PR 5): renderer-only channels on this computer's own Agent Farm folder.
 * Every file Pane writes stays inside `<PANE_DIR>/agent-farm/{plugins,drafts,avatars}` (ProfileEditor's
 * path checks). After a change, Sessions using the plugin are re-checked so they show the changed dot.
 * `runpane profiles` (PR 7) reuses ProfileEditor, and sync (PR 6) hooks into `onChanged`.
 */
export function registerProfileHandlers(ipcMain: IpcMain, services: AppServices): void {
  const editor = new ProfileEditor({
    paneDir: getAppDirectory(),
    onChanged: () => {
      void services.orchestrationSessionManager?.refreshPluginHashes(true)
        .catch(error => console.warn(`[Profiles] Could not re-check Sessions' profiles after a save: ${reasonOf(error)}`));
    },
  });
  ipcMain.handle('profiles:list', () => respond(() => editor.list()));
  ipcMain.handle('profiles:read', (_event, plugin: PaneCommandValue, file: PaneCommandValue) => respond(() => editor.read(decodeBoundary(plugin, text), decodeBoundary(file, text))));
  ipcMain.handle('profiles:save', (_event, plugin: PaneCommandValue, changes: PaneCommandValue) => respond(() => editor.save(decodeBoundary(plugin, text), decodeBoundary(changes, profileFileChangesSchema))));
  ipcMain.handle('profiles:new-profile', (_event, name: PaneCommandValue, agent: PaneCommandValue) => respond(() => editor.newProfile(decodeBoundary(name, text), decodeBoundary(agent, text))));
  ipcMain.handle('profiles:new-file', (_event, plugin: PaneCommandValue, profile: PaneCommandValue, kind: PaneCommandValue, name: PaneCommandValue) =>
    respond(() => editor.newFile(decodeBoundary(plugin, text), decodeBoundary(profile, text), decodeBoundary(kind, kindSchema), decodeBoundary(name, text))));
  ipcMain.handle('profiles:restore', (_event, plugin: PaneCommandValue) => respond(() => editor.restore(decodeBoundary(plugin, text))));
  ipcMain.handle('profiles:photos', () => respond(() => editor.photos()));
  ipcMain.handle('profiles:set-photo', (_event, ref: PaneCommandValue, base64: PaneCommandValue) => respond(() => editor.setPhoto(decodeBoundary(ref, text), decodeBoundary(base64, text))));
  ipcMain.handle('profiles:remove-photo', (_event, ref: PaneCommandValue) => respond(() => editor.removePhoto(decodeBoundary(ref, text))));
}
