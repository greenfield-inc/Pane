"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubTokenRecord = void 0;
exports.sealGitHubToken = sealGitHubToken;
exports.newSealingKeyPair = newSealingKeyPair;
exports.openGitHubToken = openGitHubToken;
/**
 * Sealing the person's GitHub token to a host's sealing key (D-107): Pane seals, the host opens. A
 * sealed box (libsodium crypto_box_seal) can be opened only with the key pair's private half, which
 * the host makes and never sends.
 */
const libsodium_wrappers_1 = __importDefault(require("libsodium-wrappers"));
const zod_1 = require("zod");
const fleet_1 = require("./fleet");
/** What a sealed GitHub token holds, as the guest writes it to `incoming/github-token.json`. */
exports.GitHubTokenRecord = zod_1.z
    .object({
    token: zod_1.z.string().min(1).max(4096),
    /** The machine the token came from: its host label, as Pane's secret sync names it. */
    source: zod_1.z.string().min(1).max(256),
    updatedAt: zod_1.z.iso.datetime({ offset: true }),
})
    .strict();
const FORMAT = () => libsodium_wrappers_1.default.base64_variants.URLSAFE_NO_PADDING;
/** Seals a GitHub token record to a sealing public key. */
async function sealGitHubToken(publicKey, record) {
    await libsodium_wrappers_1.default.ready;
    const key = libsodium_wrappers_1.default.from_base64(fleet_1.SealingPublicKey.parse(publicKey), FORMAT());
    const sealed = libsodium_wrappers_1.default.crypto_box_seal(JSON.stringify(exports.GitHubTokenRecord.parse(record)), key);
    return libsodium_wrappers_1.default.to_base64(sealed, FORMAT());
}
/** A sealing key pair, base64url: what a host makes for a free slot or a VM. */
async function newSealingKeyPair() {
    await libsodium_wrappers_1.default.ready;
    const pair = libsodium_wrappers_1.default.crypto_box_keypair();
    return { publicKey: libsodium_wrappers_1.default.to_base64(pair.publicKey, FORMAT()), privateKey: libsodium_wrappers_1.default.to_base64(pair.privateKey, FORMAT()) };
}
/** Opens a sealed GitHub token with the key pair it was sealed to; null when it doesn't open or isn't a token record. */
async function openGitHubToken(sealed, keyPair) {
    await libsodium_wrappers_1.default.ready;
    try {
        const opened = libsodium_wrappers_1.default.crypto_box_seal_open(libsodium_wrappers_1.default.from_base64(fleet_1.SealedSecret.parse(sealed), FORMAT()), libsodium_wrappers_1.default.from_base64(keyPair.publicKey, FORMAT()), libsodium_wrappers_1.default.from_base64(keyPair.privateKey, FORMAT()));
        const parsed = exports.GitHubTokenRecord.safeParse(JSON.parse(libsodium_wrappers_1.default.to_string(opened)));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
