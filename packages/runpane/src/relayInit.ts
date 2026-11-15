import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { RunpaneError } from './errors';

const USAGE = 'runpane relay init --domain <relay domain> [--public-ip <IPv4>] [--resolver <ip[:port]>]';
const GUIDE = 'https://github.com/greenfield-inc/Pane/blob/main/docs/SELF_HOSTED_RELAY.md';
const COMPOSE_URL = 'https://raw.githubusercontent.com/greenfield-inc/Pane/main/relay/compose.yaml';

interface Check {
  label: string;
  /** null when it passed, else what is wrong and what to do. */
  problem: string | null;
}

/**
 * `runpane relay init --domain relay.example.com`: prints the DNS records, ports, start command and
 * Pane setting a new relay needs, then checks each record and the running relay. Exits 0 once every
 * check passes, so it is safe to run again after each step.
 */
export async function runRelayInit(args: string[]): Promise<number> {
  let values: { domain?: string; 'public-ip'?: string; resolver?: string };
  try {
    ({ values } = parseArgs({ args, options: { domain: { type: 'string' }, 'public-ip': { type: 'string' }, resolver: { type: 'string' } } }));
  } catch (cause) {
    throw usageError(cause instanceof Error ? cause.message : String(cause));
  }
  const domain = values.domain?.trim().toLowerCase().replace(/\.$/u, '') ?? '';
  const labels = domain.split('.');
  if (labels.length < 3 || !labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw usageError(domain
      ? `"${domain}" is not a subdomain such as relay.example.com; the relay answers DNS for every name under it, so it needs a name of its own`
      : '--domain is missing');
  }
  const ip = values['public-ip'] ?? interfacePublicIp();
  if (!ip || !isIpv4(ip)) {
    throw new RunpaneError(
      'ERR_RELAY_INIT_PUBLIC_IP',
      ip ? `runpane relay init: "${ip}" is not an IPv4 address. Nothing was checked.` : 'runpane relay init found no public IPv4 address on this machine\'s network interfaces (cloud VMs often have only a private one). Nothing was checked.',
      `Pass the machine's public IPv4 address, as the cloud console shows it: ${USAGE}`,
    );
  }
  const [first, ...rest] = labels;
  const parent = rest.join('.');
  const nsHost = `${first}-ns.${parent}`;

  const pad = (name: string) => name.padEnd(Math.max(domain.length, nsHost.length) + 2);
  console.log(`Pane relay for ${domain} on ${ip}

1. Open these ports to the machine: TCP 443, UDP and TCP 53, and UDP 7842 (optional; it helps devices find direct paths).

2. Add these two records at the DNS provider for ${parent}:

     ${pad(nsHost)}A    ${ip}
     ${pad(domain)}NS   ${nsHost}

3. Start the relay on the machine, in an empty folder. On Ubuntu and Debian, free port 53 first:
   ${GUIDE}#start-one-in-five-minutes

     curl -fsSLO ${COMPOSE_URL}
     printf '%s\\n' PANE_RELAY_DOMAIN=${domain} PANE_RELAY_PUBLIC_IP=${ip} PANE_RELAY_NS=${nsHost} > .env
     docker compose up -d

   Without Docker, as root:
     npx --yes runpane@latest relay --domain ${domain} --public-ip ${ip} --ns ${nsHost} \\
       --dns 0.0.0.0:53 --direct-quic 0.0.0.0:7842 --acme-cache /var/lib/pane-relay/acme

4. On each computer, in Pane: Settings › Remote Access › More › Relay address: ${domain}
`);

  const resolver = new Resolver({ timeout: 3_000, tries: 2 });
  if (values.resolver) resolver.setServers([values.resolver]);
  const checks: Check[] = [
    await check(`${nsHost} A ${ip}`, async () => {
      const found = await resolver.resolve4(nsHost);
      return found.includes(ip) ? null : `answers ${found.join(', ')}; change the A record to ${ip}`;
    }, 'add the A record (step 2)'),
    await check(`${domain} NS ${nsHost}`, async () => {
      const found = await resolver.resolveNs(domain);
      return found.includes(nsHost) ? null : `answers ${found.join(', ')}; set PANE_RELAY_NS=${nsHost} (or --ns) and point the NS record at ${nsHost}`;
    }, 'add the NS record (step 2)', 'start the relay (step 3) and open UDP and TCP 53 (step 1)'),
    await check(`${domain} A ${ip}, answered by the relay`, async () => {
      const found = await resolver.resolve4(domain);
      return found.includes(ip) ? null : `answers ${found.join(', ')}; set PANE_RELAY_PUBLIC_IP=${ip} (or --public-ip)`;
    }, 'add the NS record (step 2)', 'start the relay (step 3) and open UDP and TCP 53 (step 1)'),
    await check(`https://${domain}/healthz`, () => health(domain, resolver), 'add the NS record (step 2)', 'start the relay (step 3) and open TCP 443 (step 1)'),
  ];
  console.log('Checks (DNS changes can take a few minutes; run this again after each step):');
  for (const { label, problem } of checks) console.log(problem ? `  ✗ ${label}: ${problem}` : `  ✓ ${label}`);
  const ready = checks.every((c) => c.problem === null);
  console.log(ready ? `\nThe relay is ready. Enter ${domain} as the Relay address in Pane.` : '');
  return ready ? 0 : 1;
}

/** Runs one check; DNS "no such record" errors become `missing`, unanswered queries become `unanswered`. */
async function check(label: string, run: () => Promise<string | null>, missing: string, unanswered = missing): Promise<Check> {
  try {
    return { label, problem: await run() };
  } catch (cause) {
    const code = cause instanceof Error && 'code' in cause ? String(cause.code) : undefined;
    if (missing && (code === 'ENOTFOUND' || code === 'ENODATA')) return { label, problem: `no record yet; ${missing}` };
    if (code === 'ESERVFAIL' || code === 'ETIMEOUT' || code === 'ECONNREFUSED' || code === 'EREFUSED') return { label, problem: `no answer yet (${code}); ${unanswered}` };
    return { label, problem: `${cause instanceof Error ? cause.message : String(cause)}; ${unanswered}` };
  }
}

/** GET /healthz on the relay, looking its name up through the same resolver as the other checks. */
function health(domain: string, resolver: Resolver): Promise<string | null> {
  const lookup: LookupFunction = (hostname, options, callback) => {
    resolver.resolve4(hostname).then(
      (addresses) => (options.all ? callback(null, addresses.map((address) => ({ address, family: 4 }))) : callback(null, addresses[0], 4)),
      (cause: NodeJS.ErrnoException) => callback(cause, '', 4),
    );
  };
  return new Promise((resolve, reject) => {
    const request = https.get({ host: domain, path: '/healthz', lookup, timeout: 5_000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200 ? null : `answered HTTP ${response.statusCode}`);
    });
    request.on('timeout', () => request.destroy(new Error('no answer within 5 s')));
    request.on('error', (cause: NodeJS.ErrnoException) => {
      // The first start serves a stand-in certificate until Let's Encrypt issues the real one.
      if (cause.code?.startsWith('ERR_TLS') || /certificate/iu.test(cause.message)) resolve(`its certificate is not trusted yet (${cause.message}); the first one takes a minute once DNS works, the relay log says "relay certificate issued"`);
      else reject(cause);
    });
  });
}

/** The first public IPv4 address on this machine's interfaces, if any. */
function interfacePublicIp(): string | undefined {
  return Object.values(os.networkInterfaces()).flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal && !isPrivate(entry.address))?.address;
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255);
}

function isPrivate(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function usageError(why: string): RunpaneError {
  return new RunpaneError('ERR_RELAY_INIT_USAGE', `runpane relay init: ${why}. Nothing was checked.`, `Run: ${USAGE}`);
}
