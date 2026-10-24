import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  pw: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  len: number,
  opts: crypto.ScryptOptions,
) => Promise<Buffer>;

// scrypt with N=2^15, r=8: about 50 ms and 32 MB per attempt, which makes offline guessing slow.
const PARAMS = { logN: 15, r: 8, p: 1 };
const KEY_LEN = 32;

/** Hash a password as `scrypt$logN$r$p$salt$hash` (base64url parts). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const { logN, r, p } = PARAMS;
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, { N: 2 ** logN, r, p, maxmem: 128 * 2 ** logN * r * 2 });
  return ['scrypt', logN, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [logN, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { N: 2 ** logN, r, p, maxmem: 128 * 2 ** logN * r * 2 });
  return crypto.timingSafeEqual(key, expected);
}

/** Problems with a new password, or null if it is acceptable. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters';
  if (pw.length > 256) return 'Use at most 256 characters';
  if (new Set(pw).size < 5) return 'Use more varied characters';
  if (/^(password|homeport|qwerty|123456|admin)/i.test(pw)) return 'That password is too easy to guess';
  return null;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------ TOTP (RFC 6238, SHA-1, 6 digits, 30 s)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(msg).digest();
  const off = mac[mac.length - 1] & 15;
  const bin = mac.readUInt32BE(off) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / 30);

/**
 * Check a 6-digit code against the current step and one step either side (clock drift).
 * Returns the matching step so callers can refuse to accept the same code twice.
 */
export function verifyTotp(secretB32: string, code: string, now = Date.now()): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32);
  const step = totpStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

export const otpauthUri = (secretB32: string, account: string, issuer = 'Homeport') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** Single-use recovery codes, shown once and stored hashed. */
export const newRecoveryCodes = () =>
  Array.from({ length: 8 }, () => {
    const s = base32Encode(crypto.randomBytes(5)).toLowerCase();
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
