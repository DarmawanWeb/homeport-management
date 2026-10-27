import { useEffect, useState } from 'react';

/** Hash routes keep the dashboard working behind any static host and without server rewrites. */
export type Route =
  | { page: 'overview' }
  | { page: 'apps' }
  | { page: 'app'; id: string; tab: AppTab }
  | { page: 'domains' }
  | { page: 'tunnels' }
  | { page: 'services' }
  | { page: 'monitoring' }
  | { page: 'caddyfile' }
  | { page: 'activity' }
  | { page: 'settings' }
  | { page: 'access' }
  | { page: 'analytics' }
  | { page: 'uptime' }
  | { page: 'network' };

export type AppTab = 'deploys' | 'logs' | 'metrics' | 'settings' | 'webhook';
const APP_TABS: AppTab[] = ['deploys', 'logs', 'metrics', 'settings', 'webhook'];
const SIMPLE = [
  'overview',
  'apps',
  'domains',
  'tunnels',
  'services',
  'monitoring',
  'caddyfile',
  'activity',
  'settings',
  'access',
  'analytics',
  'uptime',
  'network',
] as const;

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'apps' && parts[1]) {
    const tab = APP_TABS.includes(parts[2] as AppTab) ? (parts[2] as AppTab) : 'deploys';
    return { page: 'app', id: decodeURIComponent(parts[1]), tab };
  }
  const page = SIMPLE.find((p) => p === parts[0]);
  return page ? ({ page } as Route) : { page: 'overview' };
}

export function href(route: Route): string {
  if (route.page === 'app') return `#/apps/${encodeURIComponent(route.id)}${route.tab === 'deploys' ? '' : `/${route.tab}`}`;
  return `#/${route.page}`;
}

export const navigate = (route: Route) => {
  location.hash = href(route).slice(1);
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
