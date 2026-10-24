import { Boxes, CornerDownLeft, Globe, Rocket, Search } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Deploy } from '../../../src/shared/types';
import { post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { useAppState, useApps } from '../lib/queries';
import { navigate, type Route } from '../lib/router';
import { useToast } from '../lib/toast';
import { DeployLogDialog } from './Logs';

interface Command {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
  run: () => void | Promise<void>;
}

const PAGES: [Route['page'], string][] = [
  ['overview', 'Overview'],
  ['apps', 'Apps'],
  ['domains', 'Domains'],
  ['tunnels', 'Tunnels'],
  ['monitoring', 'Monitoring'],
  ['activity', 'Activity log'],
  ['services', 'Services'],
  ['caddyfile', 'Caddyfile'],
  ['settings', 'Settings'],
];

/** ⌘K: jump to any page or app, or trigger a deploy, without touching the mouse. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: apps } = useApps();
  const { data: state } = useAppState();
  const dialog = useDialog();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = PAGES.map(([page, label]) => ({
      id: `page-${page}`,
      label,
      hint: 'Page',
      icon: <CornerDownLeft />,
      run: () => navigate({ page } as Route),
    }));
    for (const a of apps?.apps ?? []) {
      list.push({
        id: `app-${a.id}`,
        label: a.name,
        hint: 'App',
        icon: <Boxes />,
        run: () => navigate({ page: 'app', id: a.id, tab: 'deploys' }),
      });
      list.push({
        id: `deploy-${a.id}`,
        label: `Deploy ${a.name}`,
        hint: 'Action',
        icon: <Rocket />,
        run: async () => {
          const r = await post<{ deploy: Deploy }>(`/api/apps/${a.id}/deploy`);
          dialog.open(<DeployLogDialog id={r.deploy.id} />, { wide: true });
        },
      });
    }
    for (const s of state?.sites ?? []) {
      list.push({
        id: `site-${s.id}`,
        label: s.hostname,
        hint: 'Open domain',
        icon: <Globe />,
        run: () => void window.open(`https://${s.hostname}`, '_blank', 'noopener'),
      });
    }
    return list;
  }, [apps, state, dialog]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return commands.slice(0, 12);
    return commands.filter((c) => c.label.toLowerCase().includes(term)).slice(0, 12);
  }, [commands, q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const run = async (c: Command | undefined) => {
    if (!c) return;
    onClose();
    try {
      await c.run();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(filtered.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void run(filtered[sel]);
    } else if (e.key === 'Escape') onClose();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes; Escape is handled on the input
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the input
    <div className="palette" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops propagation */}
      <div className="palette-box" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
            placeholder="Go to a page, an app, or deploy…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={filtered[sel] ? `cmd-${sel}` : undefined}
          />
        </div>
        <div id="palette-list" role="listbox" className="palette-list">
          {filtered.map((c, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the combobox input
            <div
              key={c.id}
              id={`cmd-${i}`}
              role="option"
              tabIndex={-1}
              className="palette-item"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => void run(c)}
            >
              {c.icon}
              {c.label}
              <span className="muted">{c.hint}</span>
            </div>
          ))}
          {filtered.length === 0 && <div className="palette-item">Nothing matches “{q}”</div>}
        </div>
      </div>
    </div>
  );
}
