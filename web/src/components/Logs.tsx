import { useEffect, useRef, useState } from 'react';
import { get } from '../lib/api';
import { fmtDuration, shortSha } from '../lib/format';
import { useToast } from '../lib/toast';
import { useQueryClient } from '@tanstack/react-query';
import { Modal, StatusTag, Tag } from './ui';
import type { Deploy } from '../../../src/shared/types';

/** Last lines of a pm2 process log. */
export function Pm2LogsDialog({ name }: { name: string }) {
  const [text, setText] = useState<string | null>(null);
  const ref = useRef<HTMLPreElement>(null);
  const load = () => get<{ text: string }>(`/api/pm2/${encodeURIComponent(name)}/logs`).then((r) => setText(r.text || '(kosong)'), (e: Error) => setText(e.message));
  useEffect(() => { void load(); }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text]);
  return (
    <Modal title={`Logs: ${name}`} footer={<><button type="button" className="btn" onClick={() => void load()}>⟳ Muat ulang</button><button type="submit" className="btn">Tutup</button></>}>
      <pre ref={ref} className="box tall">{text ?? 'Memuat…'}</pre>
    </Modal>
  );
}

/** Live deploy log: polls the incremental log endpoint until the deploy finishes. */
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
        const r = await get<{ text: string; offset: number; status: Deploy['status']; rec: Deploy }>(`/api/deploys/${id}/log?offset=${offset}`);
        if (!alive) return;
        if (r.text) {
          const box = ref.current;
          const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
          setText((t) => t + r.text);
          offset = r.offset;
          if (atBottom) requestAnimationFrame(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; });
        }
        setRec(r.rec);
        if (r.status === 'queued' || r.status === 'running') timer = setTimeout(tick, 1000);
        else {
          void qc.invalidateQueries({ queryKey: ['apps'] });
          if (r.status === 'success') toast(`Deploy ${r.rec.app} berhasil`, 'ok');
          if (r.status === 'failed') toast(`Deploy gagal: ${r.rec.error ?? ''}`, 'err');
        }
      } catch (e) {
        toast((e as Error).message, 'err');
      }
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [id, toast, qc]);

  return (
    <Modal
      title={rec ? `Deploy ${rec.app}${rec.commit ? ` · ${shortSha(rec.commit)}` : ''}` : 'Log deploy'}
      footer={<>
        <span className="grow">
          {rec && <StatusTag status={rec.status} />}{' '}
          {rec?.rolledBackTo && <Tag tone="warn">di-rollback ke {shortSha(rec.rolledBackTo)}</Tag>}{' '}
          {rec?.duration != null && <span className="sub">{fmtDuration(rec.duration)}</span>}
        </span>
        <button type="submit" className="btn">Tutup</button>
      </>}
    >
      <pre ref={ref} className="box tall">{text || 'Menunggu…'}</pre>
    </Modal>
  );
}
