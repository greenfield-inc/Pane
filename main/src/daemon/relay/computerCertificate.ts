import { X509Certificate } from 'crypto';
import https from 'https';
import tls from 'tls';
import type { ComputerKey, KeyStore } from './computerKey';

export const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';
/** Let's Encrypt's test CA: its certificates are not trusted, and its limits are separate from the real one's. */
export const LETS_ENCRYPT_STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory';
export const GOOGLE_TRUST_SERVICES_DIRECTORY = 'https://dv.acme-v02.api.pki.goog/directory';
/** Google Trust Services' test CA: untrusted certificates, its own limits, and EAB keys from the Public CA API's staging endpoint. */
export const GOOGLE_TRUST_SERVICES_STAGING_DIRECTORY = 'https://dv.acme-v02.test-api.pki.goog/directory';
/** Each request to the CA gives up after this long, so an order never hangs. */
const ACME_REQUEST_TIMEOUT_MS = 30_000;

/** Renew once a third of the lifetime is left: 30 days of 90 today, about 21 of 64 from 2027. */
const RENEW_FRACTION_LEFT = 1 / 3;

export interface CertificateStatus {
  notBefore: string;
  notAfter: string;
  renewAt: string;
  /** The issuing CA's organization, as the certificate names it. */
  issuer: string;
}

/** The CA refused for now because of its rate limits; `retryAt` is when it said to ask again, if it said. */
export class CertificateRateLimited extends Error {
  constructor(message: string, readonly retryAt: number | null) {
    super(message);
    this.name = 'CertificateRateLimited';
  }
}

/** An ACME CA the computer may order from. */
export interface CertificateAuthority {
  /** The organization its certificates name as issuer: a renewal goes first to the CA that issued the current certificate. */
  name: string;
  directoryUrl: string;
  /** The ACME account key PEM for this CA. */
  accountStore: KeyStore;
  /** A one-time EAB key for registering a new account, for a CA that requires one; throws `CertificateRateLimited` when none is to be had. */
  externalAccountKey?(): Promise<{ keyId: string; hmacKey: string }>;
}

export interface ComputerCertificateOptions {
  key: ComputerKey;
  domain: string;
  /** The certificate chain PEM; not secret. */
  certificateStore: KeyStore;
  /** In order of preference: a CA that refuses for its rate limits passes the order to the next. */
  authorities: CertificateAuthority[];
  /** Sets the `_acme-challenge.<id>.<domain>` TXT values through the relay. */
  setTxt(values: string[]): Promise<void>;
  /** Extra CA for the ACME server (a test server's own CA). */
  acmeCa?: string;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * The computer's certificate for `<id>.<domain>` and `*.<id>.<domain>`, issued over DNS-01 with
 * the computer's own key, so renewals keep the key the Pane app and desktop check.
 */
export class ComputerCertificate {
  private chain: string | null = null;
  private context: tls.SecureContext | null = null;
  private status: CertificateStatus | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ComputerCertificateOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Loads a saved certificate if it matches this key and names; an unreadable one counts as none, so a new one is ordered. */
  async load(): Promise<void> {
    const pem = await this.options.certificateStore.read();
    if (!pem) return;
    try {
      this.use(pem);
    } catch (error) {
      this.options.log?.(`[relay] ignored the saved certificate, which could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  secureContext(): tls.SecureContext | null {
    return this.context;
  }

  getStatus(): CertificateStatus | null {
    return this.status;
  }

  /** True while the saved certificate is valid now. */
  isValid(): boolean {
    return this.status !== null && Date.parse(this.status.notAfter) > this.now();
  }

  needsRenewal(): boolean {
    return this.status === null || Date.parse(this.status.renewAt) <= this.now();
  }

  /** Issues or renews when due. Concurrent calls share one order. */
  ensure(): Promise<void> {
    if (!this.needsRenewal()) return Promise.resolve();
    this.inFlight ??= this.issue().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /**
   * Orders from each CA in turn, the one that issued the current certificate first; a CA that
   * refuses for its rate limits passes the order on. Throws `CertificateRateLimited` when every CA
   * refused, with the earliest time one said to ask again.
   */
  private async issue(): Promise<void> {
    const issuer = this.status?.issuer ?? '';
    const authorities = [...this.options.authorities].sort((a, b) => Number(issuer.includes(b.name)) - Number(issuer.includes(a.name)));
    const refusals: CertificateRateLimited[] = [];
    for (const authority of authorities) {
      try {
        await this.order(authority);
        return;
      } catch (error) {
        if (!(error instanceof CertificateRateLimited)) throw error;
        this.options.log?.(`[relay] ${authority.name} refused a certificate: ${error.message}`);
        refusals.push(new CertificateRateLimited(`${authority.name}: ${error.message}`, error.retryAt));
      }
    }
    const times = refusals.flatMap((refusal) => (refusal.retryAt === null ? [] : [refusal.retryAt]));
    throw new CertificateRateLimited(refusals.map((refusal) => refusal.message).join(' '), times.length ? Math.min(...times) : null);
  }

  private async order(authority: CertificateAuthority): Promise<void> {
    const { key, domain } = this.options;
    const base = `${key.id}.${domain}`;
    // Loaded on first use: with its x509 and axios dependencies it delayed app ready
    // at every launch, and only issuing a certificate needs it.
    const acme = await import('acme-client');
    const [, csr] = await acme.crypto.createCsr({ commonName: base, altNames: [base, `*.${base}`] }, key.privateKeyPem);
    const savedAccountKey = await authority.accountStore.read();
    const accountKey = savedAccountKey ?? (await acme.crypto.createPrivateEcdsaKey('P-256')).toString();
    if (!savedAccountKey) await authority.accountStore.write(accountKey);
    if (this.options.acmeCa) acme.axios.defaults.httpsAgent = new https.Agent({ ca: this.options.acmeCa });
    // A refused or slow request fails the order instead of waiting: acme-client otherwise sleeps
    // through a rate limit's Retry-After, hours with nothing on screen. The caller retries.
    // acme-client keeps its retry settings on its axios defaults, which axios's types don't name.
    const defaults: { timeout?: number; acmeSettings?: { retryMaxAttempts: number } } = acme.axios.defaults;
    defaults.timeout = ACME_REQUEST_TIMEOUT_MS;
    if (defaults.acmeSettings) defaults.acmeSettings.retryMaxAttempts = 0;
    let client = new acme.Client({ directoryUrl: authority.directoryUrl, accountKey });
    // Looks the saved account up, so `auto` reuses it: registering a known key again makes
    // acme-client send an empty account update, which ACME servers refuse. An account this server
    // never saw (another directory) is registered by `auto`, which also reports any other failure.
    const registered = savedAccountKey !== null && await client.createAccount({ onlyReturnExisting: true }).then(() => true, () => false);
    if (!registered && authority.externalAccountKey) {
      // Each EAB key registers one account, so one is asked for only when registering.
      const { keyId, hmacKey } = await authority.externalAccountKey();
      client = new acme.Client({ directoryUrl: authority.directoryUrl, accountKey, externalAccountBinding: { kid: keyId, hmacKey } });
    }
    // The wildcard and the base name share one TXT name, so both values are published together.
    const values = new Set<string>();
    this.options.log?.(`[relay] requesting a certificate for ${base} from ${authority.name}`);
    const pem = await client.auto({
      csr,
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      // The relay confirmed the record; the ACME server checks it anyway.
      skipChallengeVerification: true,
      challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
        values.add(keyAuthorization);
        await this.options.setTxt([...values]);
      },
      challengeRemoveFn: async (_authz, _challenge, keyAuthorization) => {
        values.delete(keyAuthorization);
        await this.options.setTxt([...values]).catch(() => undefined);
      },
    }).catch((error: Error) => { throw rateLimitOf(error.message) ?? error; });
    this.use(pem);
    await this.options.certificateStore.write(pem);
    this.options.log?.(`[relay] certificate for ${base} from ${this.status?.issuer} valid until ${this.status?.notAfter}`);
  }

  private use(pem: string): void {
    const leaf = new X509Certificate(pem);
    const base = `${this.options.key.id}.${this.options.domain}`;
    // A certificate for another key or name (the key or the domain changed) is ignored.
    if (!leaf.publicKey.export({ format: 'der', type: 'spki' }).equals(this.options.key.spki) || !leaf.checkHost(base)) return;
    const notBefore = Date.parse(leaf.validFrom);
    const notAfter = Date.parse(leaf.validTo);
    const renewAt = notAfter - (notAfter - notBefore) * RENEW_FRACTION_LEFT;
    this.chain = pem;
    this.context = tls.createSecureContext({ key: this.options.key.privateKeyPem, cert: this.chain });
    this.status = {
      notBefore: new Date(notBefore).toISOString(),
      notAfter: new Date(notAfter).toISOString(),
      renewAt: new Date(renewAt).toISOString(),
      issuer: issuerName(leaf.issuer),
    };
  }
}

/** The organization (O) in an X509 issuer such as "C=US\nO=Google Trust Services\nCN=WR1", else its common name. */
function issuerName(issuer: string): string {
  const field = (name: string) => issuer.split('\n').find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
  return field('O') ?? field('CN') ?? issuer;
}

/**
 * A CA's refusal for its rate limits (RFC 8555 `rateLimited`), from the problem text acme-client
 * throws, with the time Let's Encrypt says to ask again ("retry after 2026-11-20 22:16:39 UTC").
 */
function rateLimitOf(message: string): CertificateRateLimited | null {
  if (!/rate.?limit|quota|too many (?:certificates|new orders|failed authorizations|requests)/iu.test(message)) return null;
  const when = /retry after (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC/iu.exec(message);
  const retryAt = when ? Date.parse(`${when[1]}T${when[2]}Z`) : Number.NaN;
  return new CertificateRateLimited(message, Number.isNaN(retryAt) ? null : retryAt);
}
