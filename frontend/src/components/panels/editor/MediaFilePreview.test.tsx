import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilePreviewNotice, MediaFilePreview } from './MediaFilePreview';

describe('media preview states', () => {
  it('waits for a scoped stream URL before mounting the player', () => {
    const markup = renderToStaticMarkup(<MediaFilePreview sessionId="session" filePath="movie.mp4" fileName="movie.mp4" kind="video" />);
    expect(markup).toContain('Loading media…');
    expect(markup).not.toContain('<video');
    expect(markup).not.toContain('All changes saved');
  });
  it('offers system actions when the codec cannot be previewed', () => {
    const markup = renderToStaticMarkup(<FilePreviewNotice sessionId="session" filePath="movie.mov" message="Can't preview this codec." />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Open with system app');
    expect(markup).toContain('Reveal in folder');
    expect(markup).not.toContain('<video');
    expect(markup).not.toContain('All changes saved');
  });
});
