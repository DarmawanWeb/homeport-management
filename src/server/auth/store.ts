import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

export interface SessionRecord {
  /** Public identifier, safe to show and use for revocation. */
  id: string;
  /** sha256 of the cookie token; the token itself is never stored. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string;
  userAgent: string;
  /** How the session signed in: on this machine or through a public hostname. */
  via: 'local' | 'remote';
}

export interface AuthState {
  passwordHash: string;
  passwordChangedAt: string;
  totpSecret: string;
  /** Last accepted TOTP step, so a code cannot be replayed within its window. */
  totpLastStep: number;
  recoveryCodes: string[];
  sessions: SessionRecord[];
}

export const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
/** Created by `npm run reset-password`; read once at startup. */
export const RESET_FLAG = path.join(DATA_DIR, 'RESET_AUTH');

const empty = (): AuthState => ({
  passwordHash: '',
  passwordChangedAt: '',
  totpSecret: '',
  totpLastStep: 0,
  recoveryCodes: [],
  sessions: [],
});

/** Kept in its own file with mode 600, apart from db.json, so backups and exports never carry it. */
export const auth: AuthState = empty();

export function loadAuth(): { reset: boolean } {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(RESET_FLAG)) {
    fs.rmSync(RESET_FLAG, { force: true });
    fs.rmSync(AUTH_FILE, { force: true });
    return { reset: true };
  }
  if (fs.existsSync(AUTH_FILE)) {
    try {
      Object.assign(auth, empty(), JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as Partial<AuthState>);
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

export const passwordSet = () => auth.passwordHash !== '';
export const totpEnabled = () => auth.totpSecret !== '';
