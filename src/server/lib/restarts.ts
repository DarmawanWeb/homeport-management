/**
 * pm2's restart counter also goes up on planned reloads (every deploy, every manual restart).
 * To tell crashes apart, planned actions open a short "expected" window per process name.
 */
const expectedUntil = new Map<string, number>();
const WINDOW_MS = 60_000;

export function expectRestart(name: string): void {
  expectedUntil.set(name, Date.now() + WINDOW_MS);
}

export function restartExpected(name: string): boolean {
  return (expectedUntil.get(name) ?? 0) > Date.now();
}
