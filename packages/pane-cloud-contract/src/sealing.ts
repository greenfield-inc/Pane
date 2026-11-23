/**
 * Sealing the person's GitHub token to a host's sealing key (D-107): Pane seals, the host opens. A
 * sealed box (libsodium crypto_box_seal) can be opened only with the key pair's private half, which
 * the host makes and never sends.
 */
import sodium from 'libsodium-wrappers';
import { z } from 'zod';
import { SealedSecret, SealingPublicKey } from './fleet';

/** What a sealed GitHub token holds, as the guest writes it to `incoming/github-token.json`. */
export const GitHubTokenRecord = z
  .object({
    token: z.string().min(1).max(4096),
    /** The machine the token came from: its host label, as Pane's secret sync names it. */
    source: z.string().min(1).max(256),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type GitHubTokenRecord = z.infer<typeof GitHubTokenRecord>;

const FORMAT = () => sodium.base64_variants.URLSAFE_NO_PADDING;

/** Seals a GitHub token record to a sealing public key. */
export async function sealGitHubToken(publicKey: string, record: GitHubTokenRecord): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(SealingPublicKey.parse(publicKey), FORMAT());
  const sealed = sodium.crypto_box_seal(JSON.stringify(GitHubTokenRecord.parse(record)), key);
  return sodium.to_base64(sealed, FORMAT());
}

/** A sealing key pair, base64url: what a host makes for a free slot or a VM. */
export async function newSealingKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return { publicKey: sodium.to_base64(pair.publicKey, FORMAT()), privateKey: sodium.to_base64(pair.privateKey, FORMAT()) };
}

/** Opens a sealed GitHub token with the key pair it was sealed to; null when it doesn't open or isn't a token record. */
export async function openGitHubToken(sealed: string, keyPair: { publicKey: string; privateKey: string }): Promise<GitHubTokenRecord | null> {
  await sodium.ready;
  try {
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(SealedSecret.parse(sealed), FORMAT()),
      sodium.from_base64(keyPair.publicKey, FORMAT()),
      sodium.from_base64(keyPair.privateKey, FORMAT()),
    );
    const parsed = GitHubTokenRecord.safeParse(JSON.parse(sodium.to_string(opened)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
