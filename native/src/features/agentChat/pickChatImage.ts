import * as ImagePicker from 'expo-image-picker';

import { chatImage } from './image';

/** Opens only on an attachment button press; no host upload occurs before Send. */
export async function pickChatImage() {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.9,
    base64: true,
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });
  if (result.canceled) return undefined;
  const data = result.assets[0]?.base64;
  if (!data) throw new Error('The selected image could not be read. Choose another image.');
  return chatImage(data);
}
