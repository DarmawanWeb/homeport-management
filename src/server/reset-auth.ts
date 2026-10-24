/**
 * npm run reset-password
 *
 * For when the password or the authenticator phone is lost. Run it on the Mac itself: it clears the
 * password, two-factor and every session, then restarts Homeport. Until a new password is set, only
 * this machine can open the dashboard, and public hostnames get a "set a password first" page.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { RESET_FLAG } from './auth/store.js';

fs.writeFileSync(RESET_FLAG, new Date().toISOString());
const r = spawnSync(process.platform === 'win32' ? 'pm2.cmd' : 'pm2', ['restart', 'homeport'], { stdio: 'inherit' });
if (r.status === 0) {
  console.log('\nPassword cleared. Open http://127.0.0.1:7070 on this machine to set a new one.');
} else {
  console.log('\nReset is queued. It takes effect the next time Homeport starts (pm2 restart homeport).');
}
