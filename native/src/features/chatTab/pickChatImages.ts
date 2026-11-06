import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import { chatImageProblem, type ChatDraftImage } from './chatComposer';

/** Images picked for a chat message, plus why any picked image was left out. */
export interface PickedChatImages {
  images: ChatDraftImage[];
  problem?: string;
}

/** Opens the photo library for images to attach. Resolves to no images when the person cancels. */
export async function pickChatImages(): Promise<PickedChatImages> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    allowsMultipleSelection: true,
    selectionLimit: 0,
    // Agents read JPEG, not HEIC: ask iOS for the compatible version of each photo.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });
  if (result.canceled) return { images: [] };
  const images: ChatDraftImage[] = [];
  let problem: string | undefined;
  for (const [index, asset] of result.assets.entries()) {
    const file = new File(asset.uri);
    const mimeType = asset.mimeType ?? 'image/jpeg';
    const refused = chatImageProblem({ mimeType, size: asset.fileSize ?? file.size ?? 0 });
    if (refused) { problem = `${asset.fileName ?? 'An image'} was not attached. ${refused}`; continue; }
    images.push({ key: `${asset.assetId ?? asset.uri}-${Date.now()}-${index}`, uri: asset.uri, mimeType, data: await file.base64() });
  }
  return { images, problem };
}
