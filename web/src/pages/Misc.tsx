import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Empty, Tag, Toolbar } from '../components/ui';
import { get, post } from '../lib/api';
import { useLogs, useRefresh } from '../lib/queries';
import { useToast } from '../lib/toast';

export function Caddyfile() {
  const { data, error, refetch } = useQuery({ queryKey: ['caddyfile'], queryFn: () => get<{ generated: string; current: string | null; file: string }>('/api/caddyfile') });
  const toast = useToast();
  const refresh = useRefresh();
  if (error) return <Empty>{error.message}</Empty>;
  if (!data) return <Empty>Memuat…</Empty>;
  const strip = (t: string | null) => (t ?? '').replace(/^# \d{4}-\d\d-\d\dT.*$/m, '');
  const synced = data.current !== null && strip(data.current) === strip(data.generated);
  return (
    <>
      <Toolbar title="Caddyfile">
        {synced ? <Tag tone="ok">tersinkron</Tag> : <Tag tone="err">belum di-apply</Tag>}
        <Button onClick={async () => { const r = await post<{ ok: boolean; output: string }>('/api/caddy/validate'); toast(r.ok ? 'Caddyfile valid ✓' : `Tidak valid:\n${r.output}`, r.ok ? 'ok' : 'err'); }}>Validate</Button>
        <Button variant="primary" onClick={async () => { await post('/api/caddy/apply'); toast('Applied', 'ok'); await refetch(); await refresh('status'); }}>Apply &amp; reload</Button>
      </Toolbar>
      <div className="sub mono mb">{data.file}</div>
      <pre className="box">{data.generated}</pre>
      <p className="hint">File ini dibuat dari daftar Domains. Untuk opsi global atau blok mentah tambahan, pakai kolom di Settings → Caddy.</p>
    </>
  );
}

export function Activity() {
  const { data } = useLogs();
  const [filter, setFilter] = useState<'all' | 'error'>('all');
  const logs = (data?.logs ?? []).filter((l) => filter === 'all' || l.level !== 'info');
  return (
    <>
      <Toolbar title="Log aktivitas">
        <div className="seg">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>Semua</button>
          <button className={filter === 'error' ? 'on' : ''} onClick={() => setFilter('error')}>Warning &amp; error</button>
        </div>
      </Toolbar>
      <div className="card log">
        {logs.length ? logs.map((l, i) => (
          <div key={l.t + i} className={`l ${l.level}`}>
            <span className="t">{new Date(l.t).toLocaleTimeString()}</span><span className="m">{l.msg}</span>
            {l.detail && <pre>{l.detail}</pre>}
          </div>
        )) : <Empty>Belum ada aktivitas</Empty>}
      </div>
    </>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  return (
    <form className="login card section" onSubmit={async (e) => {
      e.preventDefault();
      try { await post('/api/login', { password: pw }); onDone(); } catch (x) { setErr((x as Error).message); }
    }}>
      <h3>🔒 Homeport</h3>
      <div className="field"><label>Password</label><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></div>
      {err && <p className="err-text">{err}</p>}
      <button className="btn primary" type="submit">Masuk</button>
    </form>
  );
}
