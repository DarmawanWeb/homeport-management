import type { AppView } from '../../../src/shared/types';
import { ago, shortSha } from '../lib/format';

const SLOTS = 20;

/** A ship's log of recent deploys: one bar per deploy, oldest on the left. */
export function DeployStrip({ deploys }: { deploys: AppView['recentDeploys'] }) {
  const ordered = [...deploys].reverse();
  const pad = Math.max(0, SLOTS - ordered.length);
  const ok = deploys.filter((d) => d.status === 'success').length;
  return (
    <div className="strip" role="img" aria-label={`${deploys.length} recent deploys, ${ok} succeeded`}>
      {Array.from({ length: pad }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <i key={`pad-${i}`} data-s="pad" />
      ))}
      {ordered.map((d) => (
        <i
          key={d.id}
          data-s={d.rolledBackTo ? 'rolled' : d.status}
          title={`${shortSha(d.commit) || 'pending'} ${d.msg ?? ''}\n${d.status}${d.rolledBackTo ? ', rolled back' : ''} · ${d.trigger} · ${ago(d.createdAt)}`}
        />
      ))}
    </div>
  );
}
