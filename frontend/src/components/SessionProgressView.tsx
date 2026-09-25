import { useMemo } from 'react';

export function SessionProgressView({ html, error }: { html: string; error: string | null }) {
  const source = useMemo(() => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    // Keep the document static: no navigation, embedded browsing contexts or host integration.
    parsed.querySelectorAll('script, meta, base, link, iframe, object, embed, form').forEach(node => node.remove());
    parsed.querySelectorAll('*').forEach(node => {
      for (const attribute of Array.from(node.attributes)) {
        if (attribute.name.startsWith('on') || ['href', 'xlink:href', 'action', 'formaction', 'srcdoc'].includes(attribute.name)) {
          node.removeAttribute(attribute.name);
        }
      }
    });
    const policy = parsed.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    parsed.head.prepend(policy);
    return `<!doctype html>${parsed.documentElement.outerHTML}`;
  }, [html]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border-primary px-3 py-2 text-xs text-text-secondary">Progress · Experimental</div>
      {error && <p role="status" className="px-3 py-1 text-xs text-text-muted">{error}</p>}
      <iframe title="Session progress" sandbox="" referrerPolicy="no-referrer" srcDoc={source}
        className="min-h-0 w-full flex-1 border-0 bg-white" />
    </div>
  );
}
