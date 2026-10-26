import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { base32Encode } from './secrets.js';

export type Role = 'admin' | 'viewer';

export interface UserRecord {
  id: string;
  /** Lowercase, unique. */
  username: string;
  role: Role;
  passwordHash: string;
  passwordChangedAt: string;
  totpSecret: string;
  /** Last accepted TOTP step, so a code cannot be replayed within its window. */
  totpLastStep: number;
  /** sha256 of unused recovery codes. */
  recoveryCodes: string[];
  createdAt: string;
  lastSignInAt: string;
}

export interface SessionRecord {
  /** Public identifier, safe to show and use for revocation. */
  id: string;
  userId: string;
  /** sha256 of the cookie token; the token itself is never stored. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string;
  userAgent: string;
  /** How the session signed in: on this machine or from another device. */
  via: 'local' | 'remote';
}

export interface AuthState {
  version: 2;
  users: UserRecord[];
  sessions: SessionRecord[];
}

export const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
/** One-time code for setting the first password from another computer (NAS, server, container). */
export const SETUP_CODE_FILE = path.join(DATA_DIR, 'setup-code');
/** Created by `npm run reset-password`; read once at startup. */
export const RESET_FLAG = path.join(DATA_DIR, 'RESET_AUTH');

const empty = (): AuthState => ({ version: 2, users: [], sessions: [] });

/** Version 1 had one password and no usernames: it becomes the account "admin". */
function migrate(raw: Record<string, unknown>): AuthState {
  if (raw.version === 2) return { ...empty(), ...(raw as Partial<AuthState>), version: 2 };
  const v1 = raw as {
    passwordHash?: string;
    passwordChangedAt?: string;
    totpSecret?: string;
    totpLastStep?: number;
    recoveryCodes?: string[];
    sessions?: Omit<SessionRecord, 'userId'>[];
  };
  if (!v1.passwordHash) return empty();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  return {
    version: 2,
    users: [
      {
        id,
        username: 'admin',
        role: 'admin',
        passwordHash: v1.passwordHash,
        passwordChangedAt: v1.passwordChangedAt ?? now,
        totpSecret: v1.totpSecret ?? '',
        totpLastStep: v1.totpLastStep ?? 0,
        recoveryCodes: v1.recoveryCodes ?? [],
        createdAt: v1.passwordChangedAt ?? now,
        lastSignInAt: '',
      },
    ],
    sessions: (v1.sessions ?? []).map((x) => ({ ...x, userId: id })),
  };
}

/** Kept in its own file with mode 600, apart from db.json, so backups and exports never carry it. */
export const auth: AuthState = empty();

let migrated = false;
/** True once after a version 1 file was upgraded at startup. */
export const wasMigrated = () => migrated;

export function loadAuth(): { reset: boolean } {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(RESET_FLAG)) {
    fs.rmSync(RESET_FLAG, { force: true });
    fs.rmSync(AUTH_FILE, { force: true });
    return { reset: true };
  }
  if (fs.existsSync(AUTH_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as Record<string, unknown>;
      Object.assign(auth, migrate(raw));
      if (raw.version !== 2) migrated = true;
    } catch (e) {
      // Refuse to start rather than silently dropping the password and exposing the dashboard.
      throw new Error(`${AUTH_FILE} could not be read (${(e as Error).message}). Fix it, or run npm run reset-password.`);
    }
  }
  return { reset: false };
}

let chain: Promise<void> = Promise.resolve();
export function saveAuth(): Promise<void> {
  const snapshot = JSON.stringify(auth, null, 2);
  chain = chain
    .catch(() => undefined)
    .then(async () => {
      const tmp = `${AUTH_FILE}.tmp`;
      await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
      await fsp.rename(tmp, AUTH_FILE);
    });
  return chain;
}

/** At least one account exists; before that only the machine itself (or the setup code) gets in. */
export const passwordSet = () => auth.users.length > 0;
export const findUser = (id: string) => auth.users.find((u) => u.id === id);
export const findUserByName = (name: string) => auth.users.find((u) => u.username === name.trim().toLowerCase());
export const admins = () => auth.users.filter((u) => u.role === 'admin');

let setupCode = '';

/**
 * While no password exists, keep a random setup code in memory and in data/setup-code (mode 600),
 * and print it to the log. Whoever can read the machine's logs or files may set the first password
 * from any browser; everyone else is refused.
 */
export function prepareSetupCode(): string | null {
  if (passwordSet()) {
    fs.rmSync(SETUP_CODE_FILE, { force: true });
    setupCode = '';
    return null;
  }
  const raw = base32Encode(crypto.randomBytes(10)); // 80 bits, 16 characters
  setupCode = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  fs.writeFileSync(SETUP_CODE_FILE, `${setupCode}\n`, { mode: 0o600 });
  return setupCode;
}

export function checkSetupCode(given: string): boolean {
  if (!setupCode) return false;
  const a = Buffer.from(
    given
      .trim()
      .toUpperCase()
      .replace(/[^A-Z2-7]/g, ''),
  );
  const b = Buffer.from(setupCode.replace(/-/g, ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function clearSetupCode(): void {
  setupCode = '';
  fs.rmSync(SETUP_CODE_FILE, { force: true });
}
