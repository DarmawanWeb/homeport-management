import { type FormEvent, useState } from 'react';
import { BrandMark } from '../components/Shell';
import { Badge, Button, Empty, Loading, PageHead, Panel, Segmented } from '../components/ui';
import { post } from '../lib/api';
import { useCaddyfile, useLogs, useRefresh } from '../lib/queries';
import { useToast } from '../lib/toast';

export function Caddyfile() {
  const { data, error } = useCaddyfile();
  const toast = useToast();
  const refresh = useRefresh();
  if (error)
    return (
      <div className="page">
        <Empty title="Could not load the Caddyfile">{error.message}</Empty>
      </div>
    );
  if (!data) return <Loading />;
  const strip = (t: string | null) => (t ?? '').replace(/^# \d{4}-\d\d-\d\dT.*$/m, '');
  const synced = data.current !== null && strip(data.current) === strip(data.generated);

  return (
    <div className="page">
      <PageHead
        title="Caddyfile"
        description="Generated from your domains. Every change is validated by Caddy before it replaces the running config, and the previous file is kept as a backup."
        actions={
          <>
            <Button
              onClick={async () => {
                const r = await post<{ ok: boolean; output: string }>('/api/caddy/validate');
                toast(r.ok ? 'The Caddyfile is valid' : `Caddy rejected it:\n${r.output}`, r.ok ? 'ok' : 'err');
              }}
            >
              Validate
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                await post('/api/caddy/apply');
                toast('Applied and reloaded', 'ok');
                await refresh('caddyfile', 'status');
              }}
            >
              Apply and reload
            </Button>
          </>
        }
      />
      <Panel
        title={<span className="code">{data.file}</span>}
        actions={
          synced ? (
            <Badge tone="ok" light>
              In sync
            </Badge>
          ) : (
            <Badge tone="warn" light>
              Not applied yet
            </Badge>
          )
        }
        flush
      >
        <pre className="config">{data.generated}</pre>
      </Panel>
    </div>
  );
}

export function Activity() {
  const { data } = useLogs();
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const logs = (data?.logs ?? []).filter((l) => filter === 'all' || l.level !== 'info');
  return (
    <div className="page">
      <PageHead
        title="Activity log"
        description="Every command Homeport ran and what it said back, newest first. Kept in memory for the last 500 events."
        actions={
          <Segmented
            label="Filter"
            value={filter}
            onChange={setFilter}
            options={[
              ['all', 'Everything'],
              ['problems', 'Warnings and errors'],
            ]}
          />
        }
      />
      <Panel flush>
        {logs.length ? (
          logs.map((l) => (
            <div key={`${l.t}-${l.msg}`} className={`log-line ${l.level}`}>
              <time dateTime={l.t}>{new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
              <div>
                <div className="msg">{l.msg}</div>
                {l.detail && <pre>{l.detail}</pre>}
              </div>
            </div>
          ))
        ) : (
          <Empty title={filter === 'all' ? 'Nothing has happened yet' : 'No warnings or errors'} />
        )}
      </Panel>
    </div>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await post('/api/login', { password: pw });
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <div className="login">
      <form className="panel" onSubmit={submit}>
        <div className="panel-body form">
          <div className="brand" style={{ padding: 0 }}>
            <BrandMark />
            <span className="brand-name">Homeport</span>
          </div>
          <label className="field">
            <span>Password</span>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
          </label>
          {err && <p style={{ color: 'var(--port)', fontSize: 'var(--t-sm)' }}>{err}</p>}
          <button className="btn primary" type="submit">
            Sign in
          </button>
        </div>
      </form>
    </div>
  );
}
