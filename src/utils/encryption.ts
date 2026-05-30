import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

/**
 * Encrypt a plaintext string using AES-256-CBC.
 */
export function encrypt(text: string | null | undefined): string | null {
  if (!text) return null;
  if (!ENCRYPTION_KEY) {
    console.warn('⚠️ WARNING: ENCRYPTION_KEY not set. Storing Aadhaar in PLAINTEXT.');
    return text;
  }

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (err) {
    console.error('Encryption error:', err);
    return text;
  }
}

/**
 * Decrypt a ciphertext string.
 */
export function decrypt(text: string | null | undefined): string | null {
  if (!text) return null;
  if (!ENCRYPTION_KEY) return text;

  try {
    const parts = text.split(':');
    if (parts.length !== 2) return text; // Likely not encrypted

    const iv = Buffer.from(parts.shift()!, 'hex');
    const encryptedText = parts.join(':');
    const decipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    return text;
  }
}
