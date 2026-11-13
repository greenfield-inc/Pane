import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import { safeStorage } from 'electron';
import type { ChatAgent, ChatTabKeyStatus } from '../../../../shared/types/chatTab';

import { PaneError } from '../../../../shared/paneError';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { getAppDirectory } from '../../utils/appDirectory';
import type { ChatTabSecrets } from './launch';


const FILE = 'chat-tab-keys.json';
const schema = boundary.record(boundary.string);

/**
 * Optional API keys for chat tabs (D-14), one per agent, on this machine only.
 * They are encrypted with the OS secure store (Keychain, DPAPI or libsecret
 * through Electron's safeStorage), never synced to other hosts, never sent to
 * viewers, and given to the agent process only as env.
 */
class ChatTabKeyStore implements ChatTabSecrets {
  constructor(private readonly file = () => path.join(getAppDirectory(), FILE)) {}

  apiKey(agent: ChatAgent): string | undefined {
    const sealed = this.read().get(agent);
    if (!sealed || !safeStorage.isEncryptionAvailable()) return undefined;
    try { return safeStorage.decryptString(Buffer.from(sealed, 'base64')); }
    catch { return undefined; }
  }

  /** Which agents have a key set; never the keys themselves. */
  status(): ChatTabKeyStatus {
    return Object.fromEntries([...this.read().keys()].map(agent => [agent, true]));
  }

  set(agent: ChatAgent, key: string | null): void {
    const saved = this.read();
    if (key === null || !key.trim()) saved.delete(agent);
    else {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new PaneError('CHAT_KEY_STORE_UNAVAILABLE', 'This machine has no OS secure store Pane can use, so the key was not saved.', 'Sign in with the agent\'s own login instead: press Sign in on its chat tab.');
      }
      saved.set(agent, safeStorage.encryptString(key.trim()).toString('base64'));
    }
    if (saved.size === 0) { rmSync(this.file(), { force: true }); return; }
    writeFileSync(this.file(), JSON.stringify(Object.fromEntries(saved)), { mode: 0o600 });
  }

  /** Sealed keys by agent id. Files from before any agent could have a key held the same map. */
  private read(): Map<string, string> {
    const file = this.file();
    if (!existsSync(file)) return new Map();
    try { return new Map(Object.entries(decodeOptionalBoundary(JSON.parse(readFileSync(file, 'utf8')), schema) ?? {})); }
    catch { return new Map(); }
  }
}

export const chatTabSecrets = new ChatTabKeyStore();
