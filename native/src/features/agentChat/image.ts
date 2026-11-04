import type { AgentChatSend } from '@shared/types/agentChat';

/** Picker metadata describes the original asset; its exported bytes can be JPEG. */
export function chatImage(data: string): NonNullable<AgentChatSend['images']>[number] {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (data.length * 3 / 4 - padding > 5 * 1024 * 1024) throw new Error('Choose an image smaller than 5 MiB.');
  if (!data || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('This image could not be read. Choose it again.');
  const header = atob(data.slice(0, 32));
  let mimeType: string;
  if (header.startsWith('\xff\xd8\xff')) mimeType = 'image/jpeg';
  else if (header.startsWith('\x89PNG\r\n\x1a\n')) mimeType = 'image/png';
  else if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) mimeType = 'image/gif';
  else if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') mimeType = 'image/webp';
  else throw new Error('Choose a PNG, JPEG, WebP or GIF image.');
  return { mimeType, data };
}
