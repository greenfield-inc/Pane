/** Names under a computer's relay address, as relay/PROTOCOL.md lists them. */
export type ComputerName =
  | { kind: 'server' }
  | { kind: 'port'; port: number }
  | { kind: 'files' };

/**
 * What a TLS server name asks for on this computer: its Pane server (`<id>.<D>` or a local
 * address name `l<a>-<b>-<c>-<d>.<id>.<D>`), a dev server (`p<port>.<id>.<D>`) or preview files
 * (`files.<id>.<D>`). Null for any other name.
 */
export function parseComputerName(servername: string, id: string, domain: string): ComputerName | null {
  const name = servername.toLowerCase().replace(/\.$/u, '');
  const base = `${id}.${domain}`.toLowerCase();
  if (name === base) return { kind: 'server' };
  if (!name.endsWith(`.${base}`)) return null;
  const label = name.slice(0, -base.length - 1);
  if (label === 'files') return { kind: 'files' };
  const port = /^p(\d{1,5})$/u.exec(label);
  if (port) {
    const value = Number(port[1]);
    return value >= 1 && value <= 65535 ? { kind: 'port', port: value } : null;
  }
  if (/^l\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}$/u.test(label)) return { kind: 'server' };
  return null;
}

export function computerHost(id: string, domain: string): string {
  return `${id}.${domain}`;
}

export function portHost(port: number, id: string, domain: string): string {
  return `p${port}.${id}.${domain}`;
}

export function filesHost(id: string, domain: string): string {
  return `files.${id}.${domain}`;
}

export function localAddressHost(address: string, id: string, domain: string): string {
  return `l${address.replace(/\./gu, '-')}.${id}.${domain}`;
}
