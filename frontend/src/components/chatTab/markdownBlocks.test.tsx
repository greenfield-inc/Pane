import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownBlocks } from './markdownBlocks';

const html = (text: string) => renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>).replace(/>\s+</g, '><');

const reply = `# Plan

I changed **three** files. See https://example.com for more.

1. First step

2. Second step
   continues here

   and a second paragraph in it

- tight
- list

\`\`\`ts
const a = 1;

const b = 2;
\`\`\`

> quoted

> another quote

| a | b |
| - | - |
| 1 | 2 |

    indented code

    more indented code

---

~~~~
~~~
still code

~~~~
Done.`;

describe('markdownBlocks', () => {
  it('renders block by block exactly as the whole message renders', () => {
    const blocks = markdownBlocks(reply);
    expect(blocks.length).toBeGreaterThan(5);
    expect(blocks.join('')).toBe(reply);
    expect(blocks.map(html).join('')).toBe(html(reply));
  });

  it('never cuts inside a code block a streaming reply has not closed yet', () => {
    const streaming = 'Intro\n\n```py\nx = 1\n\ny = 2\n\nz = 3';
    expect(markdownBlocks(streaming)).toEqual(['Intro\n\n', '```py\nx = 1\n\ny = 2\n\nz = 3']);
  });

  it('keeps a message whole when references or footnotes link across it', () => {
    const linked = 'See [the docs][docs].\n\nMore text[^1].\n\n[docs]: https://example.com\n\n[^1]: A note.';
    expect(markdownBlocks(linked)).toEqual([linked]);
  });

  it('renders raw HTML that spans a blank line as the whole message does', () => {
    for (const text of ['Before\n\n<!-- a note\n\nstill the note -->\n\nAfter', 'Before\n\n<pre>\none\n\ntwo\n</pre>\n\nAfter']) {
      expect(markdownBlocks(text).map(html).join('')).toBe(html(text));
    }
  });
});
