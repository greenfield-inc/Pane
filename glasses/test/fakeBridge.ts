import type { CreateStartUpPageContainer, ImageRawDataUpdate, RebuildPageContainer, TextContainerUpgrade } from '@evenrealities/even_hub_sdk';
import { ImageRawDataUpdateResult, StartUpPageCreateResult } from '@evenrealities/even_hub_sdk';
import type { GlassesBridge } from '../src/bridge';

export type BridgeCall =
  | { method: 'create'; page: CreateStartUpPageContainer }
  | { method: 'rebuild'; page: RebuildPageContainer }
  | { method: 'upgrade'; update: TextContainerUpgrade }
  | { method: 'image'; update: ImageRawDataUpdate }
  | { method: 'shutdown'; mode: number | undefined }
  | { method: 'audio'; on: boolean };

/** Records every bridge call; no glasses, no Even app. */
export class FakeBridge implements GlassesBridge {
  readonly calls: BridgeCall[] = [];
  readonly storage = new Map<string, string>();

  async createStartUpPageContainer(page: CreateStartUpPageContainer) {
    this.calls.push({ method: 'create', page });
    return StartUpPageCreateResult.success;
  }

  async rebuildPageContainer(page: RebuildPageContainer) {
    this.calls.push({ method: 'rebuild', page });
    return true;
  }

  async textContainerUpgrade(update: TextContainerUpgrade) {
    this.calls.push({ method: 'upgrade', update });
    return true;
  }

  async updateImageRawData(update: ImageRawDataUpdate) {
    this.calls.push({ method: 'image', update });
    return ImageRawDataUpdateResult.success;
  }

  async shutDownPageContainer(mode?: number) {
    this.calls.push({ method: 'shutdown', mode });
    return true;
  }

  async audioControl(on: boolean) {
    this.calls.push({ method: 'audio', on });
    return true;
  }

  async setLocalStorage(key: string, value: string) {
    this.storage.set(key, value);
    return true;
  }

  async getLocalStorage(key: string) {
    return this.storage.get(key) ?? '';
  }
}
