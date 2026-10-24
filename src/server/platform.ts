import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Flavor, ToolKey } from '../shared/types.js';

/**
 * Where Homeport runs. It decides install hints and a few defaults; the code paths are the same
 * everywhere because Homeport only drives CLIs (pm2, caddy, cloudflared) that behave identically.
 */
export function detectFlavor(env = process.env, exists = fs.existsSync): Flavor {
  const forced = env.HOMEPORT_FLAVOR as Flavor | undefined;
  if (forced && ['mac', 'linux', 'synology', 'docker', 'windows'].includes(forced)) return forced;
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  if (exists('/.dockerenv') || env.HOMEPORT_DOCKER === '1') return 'docker';
  if (exists('/etc/synoinfo.conf') || exists('/etc.defaults/synoinfo.conf')) return 'synology';
  return 'linux';
}

export const FLAVOR: Flavor = detectFlavor();

/** Binaries installed by setup-linux.sh live here and are added to PATH. */
export const BIN_DIR = path.resolve(process.env.HOMEPORT_BIN || path.join(os.homedir(), '.homeport', 'bin'));

const BREW: Record<ToolKey, string> = {
  caddy: 'brew install caddy',
  cloudflared: 'brew install cloudflared',
  prometheus: 'brew install prometheus',
  grafana: 'brew install grafana',
  nodeExporter: 'brew install node_exporter',
  git: 'xcode-select --install',
};

const INSTALLER: Record<ToolKey, string> = {
  caddy: 'bash setup-linux.sh --only caddy',
  cloudflared: 'bash setup-linux.sh --only cloudflared',
  prometheus: 'bash setup-linux.sh --only prometheus',
  grafana: 'bash setup-linux.sh --only grafana',
  nodeExporter: 'bash setup-linux.sh --only node_exporter',
  git: 'sudo apt install git',
};

/** The command (or instruction) that installs or updates a tool on this platform. */
export function installHint(tool: ToolKey, flavor: Flavor = FLAVOR): string {
  switch (flavor) {
    case 'mac':
      return BREW[tool];
    case 'docker':
      return tool === 'grafana'
        ? 'Not in the Docker image; the charts on this page cover the same metrics'
        : 'Included in the image; pull the latest image and recreate the container';
    case 'synology':
      return tool === 'git' ? 'Install "Git Server" from Package Center' : INSTALLER[tool];
    case 'windows':
      return `winget install ${tool}`;
    default:
      return INSTALLER[tool];
  }
}

export const allHints = (flavor: Flavor = FLAVOR): Record<ToolKey, string> =>
  Object.fromEntries((Object.keys(BREW) as ToolKey[]).map((k) => [k, installHint(k, flavor)])) as Record<ToolKey, string>;

export const FLAVOR_LABEL: Record<Flavor, string> = {
  mac: 'macOS',
  linux: 'Linux',
  synology: 'Synology DSM',
  docker: 'Docker',
  windows: 'Windows',
};
