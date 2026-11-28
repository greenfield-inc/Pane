import { MAX_PROFILE_PHOTO_BYTES } from '../../../../shared/types/profileEditor';

/**
 * Profile photos (T-83): SVG only. Agent Farm keeps your photo on this computer and checks it
 * (at most 64 KiB, shapes and gradients only, no script, foreignObject, image or external href), so
 * Pane sends the SVG file's text as it is. The photo menu also offers a few sample SVGs.
 */

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
  /** The SVG's text, which Set photo sends. */
  svg: string;
  /** The same SVG as a data URL, for the menu's swatch. */
  src: string;
}

export const PHOTO_SAMPLES: PhotoSample[] = SAMPLES.map(sample => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${sample.from}"/><stop offset="1" stop-color="${sample.to}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/>${sample.body}</svg>`;
  return { id: sample.id, label: sample.label, svg, src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` };
});

/** What the file inputs accept. */
export const PHOTO_ACCEPT = '.svg,image/svg+xml';

/** Why a chosen file can't be a photo before it is read (not an SVG, or too big), or null when it may be. */
export function svgPhotoProblem(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
  if (!isSvg) return `${file.name} isn't an SVG. Profile photos are SVG files only: choose a .svg file, or pick a sample.`;
  if (file.size > MAX_PROFILE_PHOTO_BYTES) {
    return `${file.name} is ${Math.ceil(file.size / 1024)} KiB; a profile photo is at most ${MAX_PROFILE_PHOTO_BYTES / 1024} KiB. Choose a smaller SVG, or simplify this one.`;
  }
  return null;
}

/** A chosen SVG file's text, refused up front when it isn't an SVG or is too big; Agent Farm checks the rest. */
export async function readSvgPhoto(file: File): Promise<string> {
  const problem = svgPhotoProblem(file);
  if (problem) throw new Error(problem);
  const unreadable = new Error(`Pane couldn't read ${file.name}. Choose the file again.`);
  const text = await file.text().catch(() => { throw unreadable; });
  if (!text) throw unreadable;
  return text;
}
