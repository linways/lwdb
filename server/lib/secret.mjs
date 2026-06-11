/**
 * Symmetric encryption for credentials at rest (AES-256-GCM, node:crypto only).
 *
 * Stored form: `enc:1:<base64(iv[12] | tag[16] | ciphertext)>`. A value without
 * the prefix is treated as legacy plaintext and passed through on decrypt, so
 * existing rows keep working until `lwdb secure migrate` re-encrypts them.
 * Empty passwords are never encrypted (stored as '').
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:1:';
const IV_LEN = 12;
const TAG_LEN = 16;

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plaintext, key) {
  if (plaintext === undefined || plaintext === null || plaintext === '') return '';
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(blob, key) {
  if (!isEncrypted(blob)) return blob ?? ''; // legacy plaintext / empty passthrough
  const raw = Buffer.from(blob.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Bind a key into an { encrypt, decrypt } codec for the ConnectionStore. */
export function makeCodec(key) {
  return {
    encrypt: (plaintext) => encryptSecret(plaintext, key),
    decrypt: (blob) => decryptSecret(blob, key),
  };
}

/** No-op codec — stores/reads passwords verbatim (the pre-encryption default). */
export const identityCodec = {
  encrypt: (plaintext) => plaintext ?? '',
  decrypt: (blob) => blob ?? '',
};
