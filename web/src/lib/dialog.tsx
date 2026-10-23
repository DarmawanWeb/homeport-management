import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface DialogApi {
  open: (content: ReactNode, opts?: { wide?: boolean }) => void;
  close: () => void;
  isOpen: boolean;
}

const Ctx = createContext<DialogApi>({ open: () => {}, close: () => {}, isOpen: false });

/** One modal at a time, rendered in a native <dialog> (focus trap + Esc for free). */
export function DialogProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<{ content: ReactNode; wide: boolean; key: number } | null>(null);

  const open = useCallback((content: ReactNode, opts?: { wide?: boolean }) => {
    setState({ content, wide: !!opts?.wide, key: Date.now() });
  }, []);
  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (state && !d.open) d.showModal();
    if (!state && d.open) d.close();
  }, [state]);

  return (
    <Ctx.Provider value={{ open, close, isOpen: !!state }}>
      {children}
      <dialog ref={ref} className={state?.wide ? 'wide' : ''} onClose={() => setState(null)} onCancel={() => setState(null)}>
        {state && <div key={state.key}>{state.content}</div>}
      </dialog>
    </Ctx.Provider>
  );
}

export const useDialog = () => useContext(Ctx);
