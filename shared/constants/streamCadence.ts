/**
 * How often a visible stream repaints, in ms (about 30 frames a second). Terminals flush
 * output to the renderer at this interval (faster for a moment after typing), and a chat
 * tab redraws a streaming reply at most this often.
 */
export const STREAM_FRAME_MS = 32;
