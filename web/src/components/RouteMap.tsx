import { Boxes, Cable, CloudCog, Globe2, Route as RouteIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAppState, useApps, useStatus, useTunnels } from '../lib/queries';
import { href } from '../lib/router';
import { Light, type Tone } from './ui';

function Hop({
  icon,
  name,
  tone,
  detail,
  meta,
  children,
}: {
  icon: ReactNode;
  name: string;
  tone: Tone;
  detail?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`hop${tone === 'err' ? ' down' : ''}`}>
      <div className="hop-name">
        {icon}
        {name}
        <span style={{ marginLeft: 'auto' }}>
          <Light tone={tone} label={tone === 'ok' ? 'healthy' : tone === 'err' ? 'down' : 'degraded'} />
        </span>
      </div>
      {detail && <div className="hop-detail">{detail}</div>}
      {children}
      {meta && <div className="hop-meta">{meta}</div>}
    </div>
  );
}

/**
 * The path a request takes, left to right, with a live light per hop.
 * When something is down, the first red hop is where to start looking.
 */
export function RouteMap() {
  const { data: status } = useStatus();
  const { data: tunnels } = useTunnels();
  const { data: apps } = useApps();
  const { data: state } = useAppState();

  const sites = state?.sites.filter((s) => s.enabled) ?? [];
  const list = tunnels?.tunnels ?? [];
  const running = list.filter((t) => t.pm2?.status === 'online');
  const edge = running.reduce((n, t) => n + t.connections, 0);
  const caddyUp = !!status?.caddy.adminUp && !!status?.caddy.proxyUp;
  const appList = apps?.apps ?? [];
  const appsUp = appList.filter((a) => a.up).length;

  const edgeTone: Tone = !running.length ? 'err' : edge > 0 ? 'ok' : 'warn';
  const tunnelTone: Tone = !list.length || !running.length ? 'err' : running.length < list.length ? 'warn' : 'ok';
  const appsTone: Tone = !appList.length ? undefined : appsUp === appList.length ? 'ok' : appsUp === 0 ? 'err' : 'warn';

  return (
    <div className="route">
      <Hop
        icon={<Globe2 />}
        name="Visitors"
        tone={sites.length ? 'ok' : undefined}
        detail={`${sites.length} public domain${sites.length === 1 ? '' : 's'}`}
        meta="HTTPS terminates at Cloudflare"
      />
      <Hop
        icon={<CloudCog />}
        name="Cloudflare edge"
        tone={edgeTone}
        detail={running.length ? `${edge} edge connection${edge === 1 ? '' : 's'}` : 'No tunnel is connected'}
        meta="Normally 4 per tunnel"
      />
      <Hop
        icon={<Cable />}
        name="Tunnel"
        tone={tunnelTone}
        detail={list.length ? list.map((t) => t.name).join(', ') : 'None yet'}
        meta={list.length ? `${running.length} of ${list.length} running` : <a href="#/tunnels">Create one</a>}
      />
      <Hop
        icon={<RouteIcon />}
        name="Caddy"
        tone={!status ? undefined : caddyUp ? 'ok' : 'err'}
        detail={caddyUp ? `Routing ${sites.length} host${sites.length === 1 ? '' : 's'}` : 'Not running'}
        meta={status ? `Listening on :${state?.settings.caddyHttpPort ?? 8080}` : undefined}
      />
      <Hop icon={<Boxes />} name="Apps" tone={appsTone} meta={appList.length ? `${appsUp} of ${appList.length} answering` : undefined}>
        {appList.length ? (
          <div className="hop-apps">
            {appList.slice(0, 6).map((a) => (
              <a key={a.id} href={href({ page: 'app', id: a.id, tab: 'deploys' })}>
                <Light tone={a.deploying ? 'run' : a.up ? 'ok' : 'err'} />
                <span>{a.name}</span>
                <span className="code">:{a.port}</span>
              </a>
            ))}
            {appList.length > 6 && <a href="#/apps">and {appList.length - 6} more</a>}
          </div>
        ) : (
          <div className="hop-detail">
            <a href="#/apps">Deploy your first app</a>
          </div>
        )}
      </Hop>
    </div>
  );
}
