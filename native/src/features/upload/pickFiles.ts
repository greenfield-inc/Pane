import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import type { UploadFile } from './chunkedUpload';

export type AttachSource = 'photos' | 'camera' | 'files';

/** A picked file plus what the receipt shows. */
export interface PickedFile extends UploadFile {
  uri: string;
  isImage: boolean;
}

/** Opens the picker for `source`. Resolves to no files when the person cancels. */
export async function pickFiles(source: AttachSource): Promise<PickedFile[]> {
  if (source === 'files') {
    const picked = await File.pickFileAsync({ multipleFiles: true });
    if (picked.canceled) return [];
    return picked.result.map(file => toPickedFile(file.uri, file.name, file.type || 'application/octet-stream'));
  }
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error('Allow camera access in Settings to take a photo.');
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images', 'videos'],
    quality: 1,
    allowsMultipleSelection: true,
    selectionLimit: 0,
    // Agents read JPEG, not HEIC: ask iOS for the compatible version of each photo.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  };
  const result = source === 'camera'
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
    : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled) return [];
  return result.assets.map(asset => toPickedFile(
    asset.uri,
    asset.fileName ?? defaultName(asset.uri, asset.type),
    asset.mimeType ?? (asset.type === 'video' ? 'video/quicktime' : 'image/jpeg'),
  ));
}

function toPickedFile(uri: string, name: string, mimeType: string): PickedFile {
  const file = new File(uri);
  return {
    uri,
    name,
    mimeType,
    size: file.size,
    md5: file.md5 ?? '',
    isImage: mimeType.startsWith('image/'),
    read: async (offset, length) => {
      const handle = file.open();
      try {
        handle.offset = offset;
        return toBase64(handle.readBytes(length));
      } finally {
        handle.close();
      }
    },
  };
}

function defaultName(uri: string, type: ImagePicker.ImagePickerAsset['type']): string {
  return uri.split('/').pop() || (type === 'video' ? 'video.mov' : 'photo.jpg');
}

/** Hermes has `btoa`, which takes a binary string; build it in slices to keep call arguments small. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
