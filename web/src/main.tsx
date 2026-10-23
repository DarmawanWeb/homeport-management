import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout, PAGES, type Page } from './components/Layout';
import { UNAUTHORIZED_EVENT } from './lib/api';
import { DialogProvider } from './lib/dialog';
import { ToastProvider } from './lib/toast';
import { Apps } from './pages/Apps';
import { Domains } from './pages/Domains';
import { Activity, Caddyfile, Login } from './pages/Misc';
import { Monitoring } from './pages/Monitoring';
import { Overview } from './pages/Overview';
import { Services } from './pages/Services';
import { Settings } from './pages/Settings';
import { Tunnels } from './pages/Tunnels';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2000, refetchOnWindowFocus: true, retry: 1 } },
});

const pageFromHash = (): Page => {
  const h = location.hash.replace(/^#\/?/, '');
  return (PAGES.find(([k]) => k === h)?.[0] ?? 'apps') as Page;
};

function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [needLogin, setNeedLogin] = useState(false);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    const onUnauthorized = () => setNeedLogin(true);
    window.addEventListener('hashchange', onHash);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized); };
  }, []);

  const navigate = (p: Page) => { location.hash = `/${p}`; };

  if (needLogin) return <Login onDone={() => { setNeedLogin(false); void queryClient.invalidateQueries(); }} />;

  const views: Record<Page, React.ReactNode> = {
    overview: <Overview onNavigate={navigate} />,
    apps: <Apps onNavigate={navigate} />,
    domains: <Domains onNavigate={navigate} />,
    tunnels: <Tunnels onNavigate={navigate} />,
    services: <Services onNavigate={navigate} />,
    monitoring: <Monitoring />,
    caddyfile: <Caddyfile />,
    activity: <Activity />,
    settings: <Settings />,
  };
  return <Layout page={page} onNavigate={navigate}>{views[page]}</Layout>;
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
