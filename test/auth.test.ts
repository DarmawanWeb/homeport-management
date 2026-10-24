import { describe, expect, it } from 'vitest';
import { clientInfo, LoginLimiter, sameOrigin } from '../src/server/auth/guard.js';
import {
  base32Decode,
  base32Encode,
  hashPassword,
  hotp,
  newRecoveryCodes,
  passwordProblem,
  verifyPassword,
  verifyTotp,
} from '../src/server/auth/secrets.js';

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^scrypt\$15\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterz', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('uses a fresh salt each time', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });

  it('rejects weak passwords', () => {
    expect(passwordProblem('short')).toMatch(/10 characters/);
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch(/varied/);
    expect(passwordProblem('password1234')).toMatch(/guess/);
    expect(passwordProblem('tide-lantern-gravel')).toBeNull();
  });
});

describe('TOTP', () => {
  // RFC 4226 appendix D test secret.
  const rfc = Buffer.from('12345678901234567890');

  it('matches the RFC 4226 HOTP vectors', () => {
    expect([0, 1, 2, 3, 9].map((c) => hotp(rfc, c))).toEqual(['755224', '287082', '359152', '969429', '520489']);
  });

  it('round-trips base32', () => {
    expect(base32Encode(rfc)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').equals(rfc)).toBe(true);
  });

  it('accepts the current step and one either side, nothing further', () => {
    const secret = base32Encode(rfc);
    const t = 59_000; // RFC 6238: T=59s is step 1
    expect(verifyTotp(secret, '287082', t)).toBe(1);
    expect(verifyTotp(secret, '755224', t)).toBe(0);
    expect(verifyTotp(secret, '359152', t)).toBe(2);
    expect(verifyTotp(secret, '969429', t)).toBeNull();
    expect(verifyTotp(secret, 'abc', t)).toBeNull();
  });

  it('makes distinct recovery codes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/);
  });
});

describe('client detection', () => {
  it('treats a direct loopback request as local', () => {
    expect(clientInfo('127.0.0.1', { host: '127.0.0.1:7070' }).local).toBe(true);
    expect(clientInfo('::1', { host: 'localhost:7070' }).local).toBe(true);
  });

  it('treats anything through Caddy or the tunnel as remote, with the visitor IP', () => {
    const c = clientInfo('127.0.0.1', {
      host: 'deploy.example.com',
      'x-forwarded-for': '127.0.0.1',
      'cf-connecting-ip': '203.0.113.7',
      'cf-visitor': '{"scheme":"https"}',
    });
    expect(c).toEqual({ local: false, ip: '203.0.113.7', https: true });
  });

  it('is not fooled by DNS rebinding', () => {
    expect(clientInfo('127.0.0.1', { host: 'evil.example:7070' }).local).toBe(false);
  });

  it('treats LAN addresses as remote', () => {
    expect(clientInfo('192.168.1.20', { host: '127.0.0.1:7070' }).local).toBe(false);
  });

  it('checks Origin against Host', () => {
    expect(sameOrigin({ host: 'deploy.example.com' })).toBe(true);
    expect(sameOrigin({ host: 'deploy.example.com', origin: 'https://deploy.example.com' })).toBe(true);
    expect(sameOrigin({ host: 'deploy.example.com', origin: 'https://evil.example' })).toBe(false);
    expect(sameOrigin({ host: 'x', origin: 'not a url' })).toBe(false);
  });
});

describe('LoginLimiter', () => {
  const remote = { local: false, ip: '198.51.100.1', https: true };
  const local = { local: true, ip: '127.0.0.1', https: false };

  it('locks an address after the free attempts, with growing waits', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 4; i++) l.fail(remote, 0);
    expect(l.retryAfter(remote, 0)).toBe(0);
    l.fail(remote, 0);
    expect(l.retryAfter(remote, 0)).toBe(30_000);
    l.fail(remote, 0);
    expect(l.retryAfter(remote, 0)).toBe(60_000);
    l.succeed(remote);
    expect(l.retryAfter(remote, 0)).toBe(0);
  });

  it('stops distributed guessing for remote clients but not for the Mac itself', () => {
    const l = new LoginLimiter({ freeAttempts: 5, baseLockMs: 1000, maxLockMs: 1000, globalMax: 10, globalWindowMs: 60_000 });
    for (let i = 0; i < 10; i++) l.fail({ ...remote, ip: `198.51.100.${i}` }, 0);
    expect(l.retryAfter({ ...remote, ip: '198.51.100.200' }, 1000)).toBe(59_000);
    expect(l.retryAfter(local, 1000)).toBe(0);
    expect(l.retryAfter({ ...remote, ip: '198.51.100.200' }, 61_000)).toBe(0);
  });
});
