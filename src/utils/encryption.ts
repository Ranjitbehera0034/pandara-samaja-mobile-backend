import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

// Fail fast: a missing or malformed key must never silently degrade to
// storing/returning Aadhaar numbers in plaintext.
if (!ENCRYPTION_KEY || !/^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY)) {
  throw new Error(
    'ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes) for AES-256. ' +
    'Refusing to start with a missing/invalid key to avoid storing Aadhaar data in plaintext.'
  );
}

const KEY_BUFFER = Buffer.from(ENCRYPTION_KEY, 'hex');

/**
 * Encrypt a plaintext string using AES-256-CBC.
 */
export function encrypt(text: string | null | undefined): string | null {
  if (!text) return null;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY_BUFFER, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a ciphertext string produced by `encrypt`.
 *
 * Values that don't even look like our "<iv>:<hex>" format are treated as
 * legacy data written before ENCRYPTION_KEY existed in this environment
 * (this repo's own history shows it was never configured until this change) —
 * returned as-is with a loud server-side warning so it stays visible and
 * fixable, instead of crashing every read for members whose Aadhaar predates
 * encryption. A value that DOES look like our format but fails to decrypt
 * (wrong key, corrupted data) still throws — that's a real misconfiguration,
 * not legacy data, and should surface as an error.
 */
export function decrypt(text: string | null | undefined): string | null {
  if (!text) return null;

  const parts = text.split(':');
  if (parts.length !== 2 || !/^[0-9a-fA-F]+$/.test(parts[0]) || !/^[0-9a-fA-F]+$/.test(parts[1])) {
    console.warn('[encryption] Value is not in "<iv>:<hex>" ciphertext format — treating as legacy plaintext.');
    return text;
  }

  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = parts[1];
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY_BUFFER, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
