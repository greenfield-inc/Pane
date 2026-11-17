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

