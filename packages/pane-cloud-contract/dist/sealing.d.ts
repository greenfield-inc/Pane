import { z } from 'zod';
/** What a sealed GitHub token holds, as the guest writes it to `incoming/github-token.json`. */
export declare const GitHubTokenRecord: z.ZodObject<{
    token: z.ZodString;
    source: z.ZodString;
    updatedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type GitHubTokenRecord = z.infer<typeof GitHubTokenRecord>;
/** Seals a GitHub token record to a sealing public key. */
export declare function sealGitHubToken(publicKey: string, record: GitHubTokenRecord): Promise<string>;
/** A sealing key pair, base64url: what a host makes for a free slot or a VM. */
export declare function newSealingKeyPair(): Promise<{
    publicKey: string;
    privateKey: string;
}>;
/** Opens a sealed GitHub token with the key pair it was sealed to; null when it doesn't open or isn't a token record. */
export declare function openGitHubToken(sealed: string, keyPair: {
    publicKey: string;
    privateKey: string;
}): Promise<GitHubTokenRecord | null>;
