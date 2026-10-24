import {
  Activity,
  Boxes,
  Cable,
  Compass,
  FileCode2,
  Globe,
  Menu,
  Moon,
  ScrollText,
  Search,
  Server,
  Settings2,
  Sun,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { post } from '../lib/api';
import { useApps, useMonitoring, useStatus, useSystem, useTunnels } from '../lib/queries';
import { href, type Route } from '../lib/router';
import { useToast } from '../lib/toast';
import { Button, Light, Notice } from './ui';

export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="29" height="29" rx="7" stroke="currentColor" strokeWidth="2" />
      <path d="M8 15.5 16 9l8 6.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M7 20.5c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M7 25c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity=".45"
      />
    </svg>
  );
}

interface NavItem {
  route: Route;
  label: string;
  icon: ReactNode;
  count?: number;
  alert?: number;
}

function useNav(): { group: string; items: NavItem[] }[] {
  const { data: apps } = useApps();
  const { data: mon } = useMonitoring();
  const firing = mon?.alerts.filter((a) => a.state === 'firing').length ?? 0;
  return [
    {
      group: 'Run',
      items: [
        { route: { page: 'overview' }, label: 'Overview', icon: <Compass /> },
        { route: { page: 'apps' }, label: 'Apps', icon: <Boxes />, count: apps?.apps.length },
      ],
    },
    {
      group: 'Expose',
      items: [
        { route: { page: 'domains' }, label: 'Domains', icon: <Globe /> },
        { route: { page: 'tunnels' }, label: 'Tunnels', icon: <Cable /> },
      ],
    },
    {
      group: 'Observe',
      items: [
        { route: { page: 'monitoring' }, label: 'Monitoring', icon: <Activity />, alert: firing },
        { route: { page: 'activity' }, label: 'Activity log', icon: <ScrollText /> },
      ],
    },
    {
      group: 'Configure',
      items: [
        { route: { page: 'services' }, label: 'Services', icon: <Server /> },
        { route: { page: 'caddyfile' }, label: 'Caddyfile', icon: <FileCode2 /> },
        { route: { page: 'settings' }, label: 'Settings', icon: <Settings2 /> },
      ],
    },
  ];
}

const isCurrent = (item: Route, current: Route) => item.page === current.page || (item.page === 'apps' && current.page === 'app');

function currentTheme(): 'light' | 'dark' {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function Shell({ route, children, onSearch }: { route: Route; children: ReactNode; onSearch: () => void }) {
  const nav = useNav();
  const { data: status } = useStatus();
  const { data: sys } = useSystem();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(currentTheme);

  // biome-ignore lint/correctness/useExhaustiveDependencies: close the drawer whenever the route changes
  useEffect(() => setOpen(false), [route]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem('hp_theme', next);
    } catch {
      /* private mode */
    }
  };

  const lights: [string, 'ok' | 'err' | 'warn', string][] = status
    ? [
        [
          'Caddy',
          !status.caddy.version ? 'err' : status.caddy.adminUp ? 'ok' : 'warn',
          !status.caddy.version ? 'missing' : status.caddy.adminUp ? 'running' : 'stopped',
        ],
        [
          'cloudflared',
          !status.cloudflared.version ? 'err' : status.cloudflared.loggedIn ? 'ok' : 'warn',
          !status.cloudflared.version ? 'missing' : status.cloudflared.loggedIn ? 'signed in' : 'signed out',
        ],
        ['pm2', status.pm2.version ? 'ok' : 'err', status.pm2.version ? `v${status.pm2.version}` : 'missing'],
      ]
    : [];

  return (
    <div className={`shell${open ? ' nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">Homeport</div>
            <div className="brand-host">{sys?.hostname ?? '…'}</div>
          </div>
        </div>
        <nav className="stack" style={{ gap: 18 }}>
          {nav.map((g) => (
            <div key={g.group} className="nav-group">
              <h2>{g.group}</h2>
              {g.items.map((item) => (
                <a
                  key={item.label}
                  className="nav-link"
                  href={href(item.route)}
                  aria-current={isCurrent(item.route, route) ? 'page' : undefined}
                >
                  {item.icon}
                  {item.label}
                  {item.alert ? (
                    <span className="nav-alert">{item.alert}</span>
                  ) : item.count != null ? (
                    <span className="nav-count">{item.count}</span>
                  ) : null}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <section className="lights" aria-label="System status">
            {lights.map(([name, tone, text]) => (
              <div key={name}>
                <Light tone={tone} />
                <span>{name}</span>
                <span>{text}</span>
              </div>
            ))}
          </section>
          <div className="foot-row">
            <button type="button" className="btn" onClick={onSearch}>
              <Search />
              Search <kbd>⌘K</kbd>
            </button>
            <Button iconOnly icon={theme === 'dark' ? <Sun /> : <Moon />} onClick={toggleTheme}>
              {theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
            </Button>
          </div>
        </div>
      </aside>
      <button type="button" className="scrim" aria-label="Close navigation" onClick={() => setOpen(false)} />
      <div>
        <header className="topbar">
          <Button iconOnly icon={<Menu />} variant="ghost" onClick={() => setOpen(true)}>
            Open navigation
          </Button>
          <BrandMark />
          <span className="brand-name">Homeport</span>
          <span className="grow" />
          <Button iconOnly icon={<Search />} variant="ghost" onClick={onSearch}>
            Search
          </Button>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}

/** First-run guidance: shown at the top of operational pages until the basics work. */
export function SetupNotices() {
  const { data: s, refetch } = useStatus();
  const { data: tunnels } = useTunnels();
  const toast = useToast();
  if (!s) return null;
  const items: ReactNode[] = [];
  const icon = <TriangleAlert />;

  const login = async () => {
    const r = await post<{ url?: string; already?: boolean; error?: string; output?: string }>('/api/cloudflared/login');
    if (r.already) {
      toast('Already signed in to Cloudflare', 'ok');
      return refetch();
    }
    if (r.error) throw new Error(r.error + (r.output ? `\n${r.output}` : ''));
    window.open(r.url, '_blank', 'noopener');
    toast('Pick your domain on the Cloudflare page and authorize, then reload this page.', 'info', 12_000);
  };
  const startCaddy = async () => {
    const r = await post<{ note: string }>('/api/caddy/start');
    toast(r.note, 'ok');
    await refetch();
  };

  if (!s.cloudflared.version)
    items.push(
      <Notice key="cf" icon={icon}>
        cloudflared is not installed. Run <code>brew install cloudflared</code>.
      </Notice>,
    );
  else if (!s.cloudflared.loggedIn)
    items.push(
      <Notice
        key="cf"
        icon={icon}
        action={
          <Button variant="primary" size="sm" onClick={login}>
            Sign in to Cloudflare
          </Button>
        }
      >
        Sign in once so Homeport can create tunnels and DNS records. Over SSH, run <code>cloudflared tunnel login</code> instead.
      </Notice>,
    );
  if (!s.caddy.version)
    items.push(
      <Notice key="caddy" icon={icon}>
        Caddy is not installed. Run <code>brew install caddy</code>.
      </Notice>,
    );
  else if (!s.caddy.adminUp)
    items.push(
      <Notice
        key="caddy"
        icon={icon}
        action={
          <Button variant="primary" size="sm" onClick={startCaddy}>
            Start Caddy
          </Button>
        }
      >
        Caddy is stopped, so no domain can be reached.
      </Notice>,
    );
  if (tunnels && tunnels.tunnels.length === 0 && s.cloudflared.loggedIn)
    items.push(
      <Notice
        key="tunnel"
        icon={icon}
        action={
          <a className="btn primary sm" href="#/tunnels">
            Create a tunnel
          </a>
        }
      >
        There is no tunnel yet. One tunnel can carry every domain on this machine.
      </Notice>,
    );
  return items.length ? <div className="notices">{items}</div> : null;
}
