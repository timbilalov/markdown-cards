import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

export interface SessionClaims {
  id: string;
  username: string;
  issuedAt: number;
  expiresAt: number;
  rememberMe: boolean;
}

export interface IssuedSession {
  token: string;
  session: SessionClaims;
}

const normalLifetime = 8 * 60 * 60 * 1000;
const rememberedLifetime = 30 * 24 * 60 * 60 * 1000;
const maxTokenLength = 4096;
const claimKeys = ['id', 'username', 'issuedAt', 'expiresAt', 'rememberMe'];

function readSessionKey(): Buffer | null {
  // Read current private configuration on each operation, including after rotation.
  const secret = env.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length !== 64 || /[^a-fA-F0-9]/.test(secret)) {
    return null;
  }
  return Buffer.from(secret, 'hex');
}

export function checkIsUsername(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.isWellFormed() && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function checkIsTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSessionClaims(value: unknown, now: number): SessionClaims | null {
  if (!checkIsRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== claimKeys.length || !keys.every(key => claimKeys.includes(key))
    || typeof value.id !== 'string' || value.id.length !== 32 || /[^a-f0-9]/.test(value.id)
    || !checkIsUsername(value.username) || typeof value.rememberMe !== 'boolean'
    || !checkIsTimestamp(value.issuedAt) || !checkIsTimestamp(value.expiresAt)
    || !checkIsTimestamp(now)) return null;

  const lifetime = value.expiresAt - value.issuedAt;
  if (value.issuedAt > now || now >= value.expiresAt || lifetime <= 0
    || lifetime > (value.rememberMe ? rememberedLifetime : normalLifetime)) return null;

  return { id: value.id, username: value.username, issuedAt: value.issuedAt,
    expiresAt: value.expiresAt, rememberMe: value.rememberMe };
}

function decodeBase64Url(value: string): Buffer | null {
  if (!value || /[^A-Za-z0-9_-]/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  // Buffer decoding is permissive: reject padding and noncanonical unused bits.
  return bytes.toString('base64url') === value ? bytes : null;
}

// Callers must authenticate credentials first. This core does not set cookies.
export function issueSession(username: string, rememberMe: boolean = false): IssuedSession {
  const key = readSessionKey();
  if (!key) throw new Error('Invalid session configuration');
  if (!checkIsUsername(username) || typeof rememberMe !== 'boolean') {
    throw new Error('Invalid session input');
  }
  const issuedAt = Date.now();
  const expiresAt = issuedAt + (rememberMe ? rememberedLifetime : normalLifetime);
  if (!checkIsTimestamp(issuedAt) || !checkIsTimestamp(expiresAt)) {
    throw new Error('Invalid session input');
  }
  const session: SessionClaims = {
    id: randomBytes(16).toString('hex'), username, issuedAt, expiresAt, rememberMe
  };
  const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const message = `v1.${payload}`;
  const signature = createHmac('sha256', key).update(message, 'ascii').digest('base64url');
  return { token: `${message}.${signature}`, session };
}

export function verifySession(token: unknown): SessionClaims | null {
  if (typeof token !== 'string' || token.length > maxTokenLength) return null;
  try {
    const key = readSessionKey();
    if (!key) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const payload = decodeBase64Url(parts[1]);
    const signature = decodeBase64Url(parts[2]);
    if (!payload || !signature || signature.length !== 32) return null;

    const expected = createHmac('sha256', key).update(`v1.${parts[1]}`, 'ascii').digest();
    if (!timingSafeEqual(signature, expected)) return null;

    // Authenticate the exact envelope before parsing claims. Invalid UTF-8 must
    // not silently become a different username through replacement characters.
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
    const claims: unknown = JSON.parse(source);
    return parseSessionClaims(claims, Date.now());
  } catch {
    // Untrusted cookies and configuration failures never grant access or log secrets.
    return null;
  }
}
