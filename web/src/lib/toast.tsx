import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

export type Tone = 'info' | 'ok' | 'warn' | 'err';
interface Toast {
  id: number;
  msg: string;
  tone: Tone;
}

const ToastContext = createContext<(msg: string, tone?: Tone, ms?: number) => void>(() => {});
let seq = 0;

const LIGHT: Record<Tone, string> = { info: '', ok: 'ok', warn: 'warn', err: 'err' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (msg: string, tone: Tone = 'info', ms?: number) => {
      const id = ++seq;
      setItems((xs) => [...xs.slice(-4), { id, msg, tone }]);
      setTimeout(() => dismiss(id), ms ?? (tone === 'err' ? 10_000 : 4500));
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <button type="button" key={t.id} className="toast" onClick={() => dismiss(t.id)}>
            <span className={`light ${LIGHT[t.tone]}`} />
            <span>{t.msg}</span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

interface MutationOutcome {
  steps?: string[];
  warning?: string;
  apply?: {
    caddy?: { reloaded?: boolean; reason?: string };
    tunnels?: { name: string; error?: string; restarted?: boolean }[];
  };
}

/** Surface everything a config mutation reports: extra steps, warnings, apply problems. */
export function useReport() {
  const toast = useToast();
  return useCallback(
    (r: unknown, okMsg?: string) => {
      const res = (r ?? {}) as MutationOutcome;
      if (okMsg) toast(okMsg, 'ok');
      for (const s of res.steps ?? []) toast(s);
      if (res.warning) toast(res.warning, 'warn', 9000);
      const a = res.apply;
      if (a?.caddy && !a.caddy.reloaded && a.caddy.reason) toast(`${a.caddy.reason}. Start Caddy from Services.`, 'warn');
      for (const t of a?.tunnels ?? []) {
        if (t.error) toast(`Tunnel ${t.name}: ${t.error}`, 'warn');
        else if (t.restarted) toast(`Tunnel ${t.name} restarted with the new routes`);
      }
    },
    [toast],
  );
}
