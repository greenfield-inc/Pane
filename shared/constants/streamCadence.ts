/**
 * How often a visible stream repaints, in ms (about 30 frames a second). Terminal
 * output is flushed to the renderer at this interval, and a chat tab redraws a
 * streaming reply at most this often, so both surfaces stream at the same rate.
 */
export const STREAM_FRAME_MS = 32;
