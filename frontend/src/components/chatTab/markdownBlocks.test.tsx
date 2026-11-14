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

  const rendersAsWhole = (text: string) => expect(markdownBlocks(text).map(html).join('')).toBe(html(text));

  it('renders a reply still inside an unclosed code block as the whole message does', () => {
    rendersAsWhole('Intro\n\n```py\nx = 1\n\ny = 2\n\nz = 3');
  });

  it('renders a line opening with backticks that is not a fence as the whole message does', () => {
    rendersAsWhole('```a`b here\n\n```\ncode\n\nmore\n```\n\nEnd');
  });

  it('keeps a message whole when references or footnotes link across it', () => {
    expect(markdownBlocks('See [the docs][docs].\n\nMore text[^1].\n\n[docs]: https://example.com\n\n[^1]: A note.')).toHaveLength(1);
  });

  it('renders raw HTML that spans a blank line as the whole message does', () => {
    rendersAsWhole('Before\n\n<!-- a note\n\nstill the note -->\n\nAfter');
    rendersAsWhole('Before\n\n<pre>\none\n\ntwo\n</pre>\n\nAfter');
  });
});
