import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles/tokens.css';
import './styles/app.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CommandPalette } from './components/CommandPalette';
import { Shell } from './components/Shell';
import { UNAUTHORIZED_EVENT } from './lib/api';
import { DialogProvider } from './lib/dialog';
import { useRoute } from './lib/router';
import { ToastProvider } from './lib/toast';
import { AppDetail } from './pages/AppDetail';
import { Apps } from './pages/Apps';
import { Domains } from './pages/Domains';
import { Activity, Caddyfile, Login } from './pages/Misc';
import { Monitoring } from './pages/Monitoring';
import { Overview } from './pages/Overview';
import { Services } from './pages/Services';
import { Settings } from './pages/Settings';
import { Tunnels } from './pages/Tunnels';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2000, refetchOnWindowFocus: true, retry: 1 } },
});

const TITLES: Record<string, string> = {
  overview: 'Overview',
  apps: 'Apps',
  domains: 'Domains',
  tunnels: 'Tunnels',
  services: 'Services',
  monitoring: 'Monitoring',
  caddyfile: 'Caddyfile',
  activity: 'Activity log',
  settings: 'Settings',
};

function App() {
  const route = useRoute();
  const [needLogin, setNeedLogin] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => setNeedLogin(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    document.title = `${route.page === 'app' ? route.id : TITLES[route.page]} · Homeport`;
  }, [route]);

  if (needLogin)
    return (
      <Login
        onDone={() => {
          setNeedLogin(false);
          void queryClient.invalidateQueries();
        }}
      />
    );

  return (
    <Shell route={route} onSearch={() => setPalette(true)}>
      {route.page === 'overview' && <Overview />}
      {route.page === 'apps' && <Apps />}
      {route.page === 'app' && <AppDetail id={route.id} tab={route.tab} />}
      {route.page === 'domains' && <Domains />}
      {route.page === 'tunnels' && <Tunnels />}
      {route.page === 'services' && <Services />}
      {route.page === 'monitoring' && <Monitoring />}
      {route.page === 'caddyfile' && <Caddyfile />}
      {route.page === 'activity' && <Activity />}
      {route.page === 'settings' && <Settings />}
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </Shell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <DialogProvider>
          <App />
        </DialogProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
