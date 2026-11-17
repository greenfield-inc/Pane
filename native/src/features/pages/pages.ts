/**
 * What a static page's WebView does with a load: `load` the page itself (`about:blank`, how a
 * WebView names inline html) or one of its own anchors, `open` a tapped http(s) link in the phone's
 * browser, and `refuse` the rest, including anything a frame inside the page asks for.
 */
export function pageLoad(url: string, isTopFrame: boolean): 'load' | 'open' | 'refuse' {
  if (url === 'about:blank' || url.startsWith('about:blank#')) return 'load';
  if (isTopFrame && /^https?:\/\//i.test(url)) return 'open';
  return 'refuse';
}

const NO_NETWORK = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">';

/**
 * A linked file's html with a content policy that loads nothing from the network: inline styles,
 * and images and fonts as data URLs. The policy goes first in the head, or after the doctype.
 */
export function withNoNetwork(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + NO_NETWORK + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + NO_NETWORK + html.slice(doctype[0].length);
  return NO_NETWORK + html;
}
