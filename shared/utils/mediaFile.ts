/** Ogg can contain audio or video; a video element plays both. */
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogg', 'ogv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'oga', 'opus']);

export function mediaFileKind(filePath: string): 'video' | 'audio' | null {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return null;
}
