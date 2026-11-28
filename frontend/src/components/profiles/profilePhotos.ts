import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

/**
 * Profile photos (T-63 PR 5): the sample pictures the photo menu offers, and scaling a chosen
 * picture into the small square PNG Pane stores per profile on this computer.
 */

/** The side, in px, of a stored photo: twice the largest avatar Pane draws (44 px in the photo menu), with room for 3x screens. */
const PHOTO_SIDE = 160;

/** A sample picture: a two-colour gradient with a simple figure. These are pictures, not interface colours. */
interface Sample {
  id: string;
  label: string;
  from: string;
  to: string;
  body: string;
}

const SAMPLES: Sample[] = [
  { id: 'sunrise', label: 'Smiling face, warm', from: '#f4b183', to: '#e3735e', body: '<circle cx="32" cy="26" r="12" fill="#fff3e8"/><path d="M12 60c2-14 10-20 20-20s18 6 20 20" fill="#fff3e8"/><circle cx="27" cy="25" r="1.8" fill="#4a2b22"/><circle cx="37" cy="25" r="1.8" fill="#4a2b22"/><path d="M27 31c3 3 7 3 10 0" stroke="#4a2b22" stroke-width="1.8" fill="none" stroke-linecap="round"/>' },
  { id: 'glasses', label: 'Face with glasses, blue', from: '#9ad0f5', to: '#4b7bd8', body: '<circle cx="32" cy="27" r="12" fill="#e9f3ff"/><path d="M12 60c2-14 10-20 20-20s18 6 20 20" fill="#e9f3ff"/><rect x="21" y="22" width="9" height="6" rx="3" fill="none" stroke="#1e3a6e" stroke-width="1.6"/><rect x="34" y="22" width="9" height="6" rx="3" fill="none" stroke="#1e3a6e" stroke-width="1.6"/><path d="M30 25h4" stroke="#1e3a6e" stroke-width="1.6"/>' },
  { id: 'fringe', label: 'Face with a fringe, green', from: '#b7e4c7', to: '#40916c', body: '<circle cx="32" cy="27" r="12" fill="#f1fbf4"/><path d="M12 60c2-14 10-20 20-20s18 6 20 20" fill="#f1fbf4"/><path d="M20 22c3-9 21-9 24 0" fill="#1b4332"/><circle cx="27" cy="27" r="1.8" fill="#1b4332"/><circle cx="37" cy="27" r="1.8" fill="#1b4332"/>' },
  { id: 'star', label: 'Star, violet', from: '#d8b4fe', to: '#7c3aed', body: '<path d="M32 12l6 13 14 1-11 9 4 14-13-8-13 8 4-14-11-9 14-1z" fill="#f5ecff"/>' },
  { id: 'sun', label: 'Sun, amber', from: '#fde68a', to: '#d97706', body: '<circle cx="32" cy="32" r="13" fill="#fffbea"/><g stroke="#fffbea" stroke-width="3" stroke-linecap="round"><path d="M32 8v6M32 50v6M8 32h6M50 32h6M15 15l4 4M45 45l4 4M15 49l4-4M45 19l4-4"/></g>' },
  { id: 'heart', label: 'Heart, rose', from: '#fecdd3', to: '#e11d48', body: '<path d="M32 50S14 39 14 27a9 9 0 0 1 18-3 9 9 0 0 1 18 3c0 12-18 23-18 23z" fill="#fff1f3"/>' },
];

export interface PhotoSample {
  id: string;
  label: string;
  /** An SVG data URL. */
  src: string;
}

export const PHOTO_SAMPLES: PhotoSample[] = SAMPLES.map(sample => ({
  id: sample.id,
  label: sample.label,
  src: `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${sample.from}"/><stop offset="1" stop-color="${sample.to}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/>${sample.body}</svg>`)}`,
}));

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That file isn\'t a picture Pane can read. Choose a PNG, JPEG, GIF, WebP or SVG.'));
    image.src = src;
  });
}

/** A picture (any URL the window can draw), cropped to its centre square and scaled to a PNG; its base64. */
export async function squarePhoto(src: string): Promise<string> {
  const image = await loadImage(src);
  const width = image.naturalWidth || PHOTO_SIDE;
  const height = image.naturalHeight || PHOTO_SIDE;
  const side = Math.min(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_SIDE;
  canvas.height = PHOTO_SIDE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Pane couldn\'t draw the picture. Try another one.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, PHOTO_SIDE, PHOTO_SIDE);
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

/** A file the person chose, as a data URL. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = decodeOptionalBoundary(reader.result, boundary.string);
      if (url) resolve(url);
      else reject(new Error('Pane couldn\'t read that file.'));
    };
    reader.onerror = () => reject(new Error('Pane couldn\'t read that file.'));
    reader.readAsDataURL(file);
  });
}
