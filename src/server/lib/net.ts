import net from 'node:net';

/** True if something accepts TCP connections on host:port. */
export function portOpen(host: string, port: number, timeout = 800): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, '');
  const candidates = h === 'localhost' ? ['127.0.0.1', '::1'] : [h];
  return candidates.reduce<Promise<boolean>>(
    (prev, addr) => prev.then((ok) => ok || tryConnect(addr, port, timeout)),
    Promise.resolve(false),
  );
}

function tryConnect(host: string, port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v: boolean) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
