import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotebookPreview } from './NotebookPreview';

describe('NotebookPreview', () => {
  it('renders application/json output as escaped text', () => {
    const content = JSON.stringify({
      cells: [{
        cell_type: 'code',
        source: [],
        outputs: [{
          output_type: 'display_data',
          data: {
            'application/json': JSON.stringify({ value: '<script>alert("unsafe")</script>' }),
          },
        }],
      }],
    });

    const markup = renderToStaticMarkup(<NotebookPreview content={content} />);

    expect(markup).toContain('&lt;script&gt;alert(');
    expect(markup).toContain('&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
  });
});
