import { useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Deploy } from '../../../src/shared/types';
import { get } from '../lib/api';
import { fmtDuration, shortSha } from '../lib/format';
import { useToast } from '../lib/toast';
import { Button, DeployBadge, Modal } from './ui';

/** Tail of a pm2 process log; used inline on the app page and in a modal elsewhere. */
export function Pm2Log({ name }: { name: string }) {
  const [text, setText] = useState<string | null>(null);
  const ref = useRef<HTMLPreElement>(null);
  const load = useCallback(
    () =>
      get<{ text: string }>(`/api/pm2/${encodeURIComponent(name)}/logs`).then(
        (r) => setText(r.text || 'No output yet.'),
        (e: Error) => setText(e.message),
      ),
    [name],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (ref.current && text) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <div className="stack">
      <div className="btn-row">
        <span className="muted">Last 150 lines from pm2</span>
        <Button size="sm" icon={<RotateCw />} onClick={load} className="right-push">
          Reload
        </Button>
      </div>
      <pre ref={ref} className="terminal">
        {text ?? 'Loading…'}
      </pre>
    </div>
  );
}

export const Pm2LogsDialog = ({ name }: { name: string }) => (
  <Modal title={`Logs for ${name}`}>
    <Pm2Log name={name} />
  </Modal>
);

/** Live deploy log: polls the incremental log endpoint until the deploy settles. */
export function DeployLogDialog({ id }: { id: string }) {
  const [text, setText] = useState('');
  const [rec, setRec] = useState<Deploy | null>(null);
  const ref = useRef<HTMLPreElement>(null);
  const toast = useToast();
  const qc = useQueryClient();

  useEffect(() => {
    let offset = 0;
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const tick = async () => {
      try {
        const r = await get<{ text: string; offset: number; status: Deploy['status']; rec: Deploy }>(
          `/api/deploys/${id}/log?offset=${offset}`,
        );
        if (!alive) return;
        if (r.text) {
          const box = ref.current;
          const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
          setText((t) => t + r.text);
          offset = r.offset;
          if (atBottom)
            requestAnimationFrame(() => {
              if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
            });
        }
        setRec(r.rec);
        if (r.status === 'queued' || r.status === 'running') timer = setTimeout(tick, 1000);
        else {
          void qc.invalidateQueries({ queryKey: ['apps'] });
          void qc.invalidateQueries({ queryKey: ['deploys'] });
          if (r.status === 'success') toast(`${r.rec.app} is live`, 'ok');
          if (r.status === 'failed')
            toast(
              r.rec.rolledBackTo
                ? `${r.rec.app}: deploy failed, previous version restored`
                : `${r.rec.app}: ${r.rec.error ?? 'deploy failed'}`,
              'err',
            );
        }
      } catch (e) {
        toast((e as Error).message, 'err');
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, toast, qc]);

  return (
    <Modal
      title={rec ? `Deploying ${rec.app}${rec.commit ? ` at ${shortSha(rec.commit)}` : ''}` : 'Deploy log'}
      footer={
        <>
          <span className="grow">
            {rec && <DeployBadge status={rec.status} rolledBack={!!rec.rolledBackTo} />}
            {rec?.duration != null && <span className="muted">{fmtDuration(rec.duration)}</span>}
          </span>
          <button type="submit" className="btn">
            Close
          </button>
        </>
      }
    >
      <pre ref={ref} className="terminal">
        {text || 'Waiting for the first step…'}
      </pre>
    </Modal>
  );
}
