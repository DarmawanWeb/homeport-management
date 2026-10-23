import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export type ToastType = 'info' | 'ok' | 'warn' | 'err';
interface Toast { id: number; msg: string; type: ToastType }

const Ctx = createContext<(msg: string, type?: ToastType, ms?: number) => void>(() => {});
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const toast = useCallback((msg: string, type: ToastType = 'info', ms?: number) => {
    const id = ++seq;
    setItems((xs) => [...xs, { id, msg, type }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), ms ?? (type === 'err' ? 10_000 : 4500));
  }, []);
  return (
    <Ctx.Provider value={toast}>
      {children}
      <div className="toasts" role="status">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.type}`} onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>{t.msg}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);

/** Show the outcome of a mutation that may carry steps, a warning and an apply result. */
export function useReport() {
  const toast = useToast();
  return useCallback((r: unknown, okMsg?: string) => {
    const res = (r ?? {}) as {
      steps?: string[]; warning?: string;
      apply?: { caddy?: { reloaded?: boolean; reason?: string }; tunnels?: { name: string; error?: string; restarted?: boolean }[] };
    };
    if (okMsg) toast(okMsg, 'ok');
    res.steps?.forEach((s) => toast(s));
    if (res.warning) toast(`⚠ ${res.warning}`, 'warn', 9000);
    const a = res.apply;
    if (a?.caddy && !a.caddy.reloaded && a.caddy.reason) toast(`${a.caddy.reason} — start Caddy di tab Services`, 'warn');
    a?.tunnels?.filter((t) => t.error).forEach((t) => toast(`Tunnel ${t.name}: ${t.error}`, 'warn'));
    a?.tunnels?.filter((t) => t.restarted).forEach((t) => toast(`Tunnel ${t.name} di-restart`));
  }, [toast]);
}
