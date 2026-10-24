import { describe, expect, it } from 'vitest';
import { allHints, detectFlavor, installHint } from '../src/server/platform.js';

const none = () => false;
const only =
  (...files: string[]) =>
  (p: string) =>
    files.includes(p);

describe('platform detection', () => {
  it('honours an explicit HOMEPORT_FLAVOR', () => {
    expect(detectFlavor({ HOMEPORT_FLAVOR: 'synology' }, none)).toBe('synology');
    expect(detectFlavor({ HOMEPORT_FLAVOR: 'nonsense' }, none)).not.toBe('nonsense');
  });

  it.runIf(process.platform === 'linux')('tells Docker, Synology and plain Linux apart', () => {
    expect(detectFlavor({}, only('/.dockerenv'))).toBe('docker');
    expect(detectFlavor({ HOMEPORT_DOCKER: '1' }, none)).toBe('docker');
    expect(detectFlavor({}, only('/etc/synoinfo.conf'))).toBe('synology');
    // Docker running on a Synology is still Docker: the container has its own filesystem.
    expect(detectFlavor({}, only('/.dockerenv', '/etc/synoinfo.conf'))).toBe('docker');
    expect(detectFlavor({}, none)).toBe('linux');
  });

  it('gives install hints that fit the platform', () => {
    expect(installHint('caddy', 'mac')).toBe('brew install caddy');
    expect(installHint('caddy', 'linux')).toBe('bash setup-linux.sh --only caddy');
    expect(installHint('git', 'synology')).toMatch(/Package Center/);
    expect(installHint('prometheus', 'docker')).toMatch(/image/);
    expect(Object.keys(allHints('linux')).sort()).toEqual(['caddy', 'cloudflared', 'git', 'grafana', 'nodeExporter', 'prometheus']);
  });
});
