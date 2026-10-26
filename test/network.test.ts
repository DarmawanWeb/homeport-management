import type os from 'node:os';
import { describe, expect, it } from 'vitest';
import { isLanBind, lanAddresses } from '../src/server/services/network.js';

const v4 = (address: string, internal = false) => ({ family: 'IPv4', address, internal }) as os.NetworkInterfaceInfo;

describe('local network access', () => {
  it('knows which bind addresses reach the LAN', () => {
    expect(isLanBind('0.0.0.0')).toBe(true);
    expect(isLanBind('192.168.1.20')).toBe(true);
    expect(isLanBind('127.0.0.1')).toBe(false);
    expect(isLanBind('localhost')).toBe(false);
  });

  it('lists the LAN address first and skips loopback, Docker and VPN tunnels', () => {
    const list = lanAddresses({
      lo0: [v4('127.0.0.1', true)],
      utun3: [v4('10.8.0.2')],
      docker0: [v4('172.17.0.1')],
      tailscale0: [v4('100.101.1.2')],
      en0: [v4('192.168.1.20'), { family: 'IPv6', address: 'fe80::1', internal: false } as os.NetworkInterfaceInfo],
    });
    expect(list).toEqual(['192.168.1.20', '100.101.1.2']);
  });

  it('falls back to any address when there is no private one', () => {
    expect(lanAddresses({ eth0: [v4('203.0.113.5')] })).toEqual(['203.0.113.5']);
  });
});
