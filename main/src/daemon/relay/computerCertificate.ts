import { X509Certificate } from 'crypto';
import https from 'https';
import tls from 'tls';
import * as acme from 'acme-client';
import type { ComputerKey, KeyStore } from './computerKey';

export const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';

/** Renew once a third of the lifetime is left: 30 days of 90 today, about 21 of 64 from 2027. */
const RENEW_FRACTION_LEFT = 1 / 3;

export interface CertificateStatus {
  notBefore: string;
  notAfter: string;
  renewAt: string;
}

export interface ComputerCertificateOptions {
  key: ComputerKey;
  domain: string;
  /** The certificate chain PEM; not secret. */
  certificateStore: KeyStore;
  /** The ACME account key PEM. */
  accountStore: KeyStore;
  /** Sets the `_acme-challenge.<id>.<domain>` TXT values through the relay. */
  setTxt(values: string[]): Promise<void>;
  directoryUrl?: string;
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

  private async issue(): Promise<void> {
    const { key, domain } = this.options;
    const base = `${key.id}.${domain}`;
    const [, csr] = await acme.crypto.createCsr({ commonName: base, altNames: [base, `*.${base}`] }, key.privateKeyPem);
    const savedAccountKey = await this.options.accountStore.read();
    const accountKey = savedAccountKey ?? (await acme.crypto.createPrivateEcdsaKey('P-256')).toString();
    if (!savedAccountKey) await this.options.accountStore.write(accountKey);
    if (this.options.acmeCa) acme.axios.defaults.httpsAgent = new https.Agent({ ca: this.options.acmeCa });
    const client = new acme.Client({ directoryUrl: this.options.directoryUrl ?? LETS_ENCRYPT_DIRECTORY, accountKey });
    if (savedAccountKey) {
      // Looks the saved account up, so `auto` reuses it: registering a known key again makes
      // acme-client send an empty account update, which ACME servers refuse. An account this server
      // never saw (another directory) is registered by `auto`, which also reports any other failure.
      await client.createAccount({ onlyReturnExisting: true }).catch(() => undefined);
    }
    // The wildcard and the base name share one TXT name, so both values are published together.
    const values = new Set<string>();
    this.options.log?.(`[relay] requesting a certificate for ${base}`);
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
    });
    this.use(pem);
    await this.options.certificateStore.write(pem);
    this.options.log?.(`[relay] certificate for ${base} valid until ${this.status?.notAfter}`);
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
    };
  }
}
