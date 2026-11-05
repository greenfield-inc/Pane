import type { AppConfig } from '../types/config';
import { keychainSecretBackend, PaneSecretStore } from '../services/paneSecrets';
import type { FakeKeychain } from './fakeKeychain';

/** The ConfigManager methods the secret store uses, over config held in memory. */
export function memoryConfig() {
  let config: AppConfig = {};
  return {
    getConfig: () => config,
    updateConfigWith: async (update: (current: AppConfig) => Partial<AppConfig>) => {
      config = { ...config, ...update(config) };
      return config;
    },
  };
}

/** A Pane secret store whose values live in `keychain` under service `Pane`, account `secret:<project>/<NAME>`. */
export function memorySecretStore(keychain: FakeKeychain): PaneSecretStore {
  return new PaneSecretStore(memoryConfig(), keychainSecretBackend(keychain, 'Pane'), () => 'this-mac');
}
