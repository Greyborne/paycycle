import crypto from 'node:crypto';
import { config } from '../config.js';

// At-rest encryption for third-party secrets (SimpleFIN access URLs). AES-
// 256-GCM keyed off the instance's session secret — rotating that secret
// means relinking banks, which is the right failure mode for a self-hosted
// tool.
const PREFIX = 'enc:v1:';
const key = () => crypto.createHash('sha256').update(`paycycle-secrets:${config.sessionSecret}`).digest();

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptSecret(stored) {
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export const isEncrypted = (stored) => stored.startsWith(PREFIX);
